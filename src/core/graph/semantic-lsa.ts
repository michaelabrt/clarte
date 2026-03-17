/**
 * Bipartite LSA seed expansion via randomized truncated SVD.
 *
 * Builds a file-symbol incidence matrix, computes low-rank file embeddings
 * using the Halko-Martinsson-Tropp randomized SVD algorithm, then expands
 * BM25F seeds with conceptually similar files via cosine similarity to
 * the seed centroid.
 *
 * All linear algebra uses flat Float64Array with no external dependencies.
 * For typical codebases (1000 files, 20 imports/file), the full pipeline
 * completes in sub-millisecond.
 */

import type { InMemorySymbolGraph } from "../../storage/types";
import {
  LSA_RANK,
  LSA_OVERSAMPLING,
  LSA_POWER_ITERATIONS,
  LSA_COSINE_THRESHOLD,
  LSA_EXPANSION_DISCOUNT,
  LSA_MAX_EXPANSIONS,
  LSA_MIN_FILES,
} from "../config/phase7-constants";

// ── Sparse CSR ───────────────────────────────────────────────────────────────

export interface SparseCSR {
  rows: number;
  cols: number;
  rowPtr: Int32Array;
  colIdx: Int32Array;
  values: Float64Array;
}

// ── Dense matrix primitives ──────────────────────────────────────────────────

/** C = A * B where A is m x k, B is k x n. Row-major layout. */
export function matmul(A: Float64Array, m: number, k: number, B: Float64Array, n: number): Float64Array {
  const C = new Float64Array(m * n);
  for (let i = 0; i < m; i++) {
    const iOffset = i * k;
    const cOffset = i * n;
    for (let l = 0; l < k; l++) {
      const a = A[iOffset + l];
      if (a === 0) continue;
      const bOffset = l * n;
      for (let j = 0; j < n; j++) {
        C[cOffset + j] += a * B[bOffset + j];
      }
    }
  }
  return C;
}

/** Modified Gram-Schmidt QR. A is m x k (modified in place to Q). */
export function qr(A: Float64Array, m: number, k: number): { Q: Float64Array; R: Float64Array } {
  const Q = new Float64Array(A);
  const R = new Float64Array(k * k);

  for (let j = 0; j < k; j++) {
    let norm = 0;
    for (let i = 0; i < m; i++) norm += Q[i * k + j] ** 2;
    norm = Math.sqrt(norm);
    R[j * k + j] = norm;

    if (norm < 1e-15) continue;

    for (let i = 0; i < m; i++) Q[i * k + j] /= norm;

    for (let jj = j + 1; jj < k; jj++) {
      let dot = 0;
      for (let i = 0; i < m; i++) dot += Q[i * k + j] * Q[i * k + jj];
      R[j * k + jj] = dot;
      for (let i = 0; i < m; i++) Q[i * k + jj] -= dot * Q[i * k + j];
    }
  }

  return { Q, R };
}

/**
 * Jacobi eigenvalue decomposition of a symmetric k x k matrix.
 * Returns eigenvalues (diagonal) and eigenvectors (columns of V).
 */
export function jacobiEigen(A: Float64Array, n: number): { eigenvalues: Float64Array; eigenvectors: Float64Array } {
  const S = new Float64Array(A);
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1.0;

  for (let iter = 0; iter < 100; iter++) {
    let maxVal = 0;
    let p = 0;
    let q = 1;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const val = Math.abs(S[i * n + j]);
        if (val > maxVal) {
          maxVal = val;
          p = i;
          q = j;
        }
      }
    }
    if (maxVal < 1e-12) break;

    const theta = 0.5 * Math.atan2(2 * S[p * n + q], S[p * n + p] - S[q * n + q]);
    const c = Math.cos(theta);
    const s = Math.sin(theta);

    // G^T * S (rotate rows p and q)
    for (let j = 0; j < n; j++) {
      const spj = S[p * n + j];
      const sqj = S[q * n + j];
      S[p * n + j] = c * spj + s * sqj;
      S[q * n + j] = -s * spj + c * sqj;
    }
    // S * G (rotate columns p and q)
    for (let i = 0; i < n; i++) {
      const sip = S[i * n + p];
      const siq = S[i * n + q];
      S[i * n + p] = c * sip + s * siq;
      S[i * n + q] = -s * sip + c * siq;
    }
    // Accumulate eigenvectors: V = V * G
    for (let i = 0; i < n; i++) {
      const vip = V[i * n + p];
      const viq = V[i * n + q];
      V[i * n + p] = c * vip + s * viq;
      V[i * n + q] = -s * vip + c * viq;
    }
  }

  const eigenvalues = new Float64Array(n);
  for (let i = 0; i < n; i++) eigenvalues[i] = S[i * n + i];
  return { eigenvalues, eigenvectors: V };
}

/** Cosine similarity between two vectors. */
export function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ── Sparse matrix operations ─────────────────────────────────────────────────

/** Y = M * D where M is sparse CSR (m x n), D is dense (n x k). Result: m x k. */
function sparseMatDense(csr: SparseCSR, D: Float64Array, k: number): Float64Array {
  const Y = new Float64Array(csr.rows * k);
  for (let row = 0; row < csr.rows; row++) {
    const start = csr.rowPtr[row];
    const end = csr.rowPtr[row + 1];
    const yOffset = row * k;
    for (let idx = start; idx < end; idx++) {
      const col = csr.colIdx[idx];
      const val = csr.values[idx];
      const dOffset = col * k;
      for (let j = 0; j < k; j++) {
        Y[yOffset + j] += val * D[dOffset + j];
      }
    }
  }
  return Y;
}

/** Z = M^T * D where M is sparse CSR (m x n), D is dense (m x k). Result: n x k. */
function sparseTransposeMatDense(csr: SparseCSR, D: Float64Array, k: number): Float64Array {
  const Z = new Float64Array(csr.cols * k);
  for (let row = 0; row < csr.rows; row++) {
    const start = csr.rowPtr[row];
    const end = csr.rowPtr[row + 1];
    const dOffset = row * k;
    for (let idx = start; idx < end; idx++) {
      const col = csr.colIdx[idx];
      const val = csr.values[idx];
      const zOffset = col * k;
      for (let j = 0; j < k; j++) {
        Z[zOffset + j] += val * D[dOffset + j];
      }
    }
  }
  return Z;
}

// ── Gaussian random ──────────────────────────────────────────────────────────

function gaussianRandom(): number {
  let u1 = 0;
  let u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

// ── Incidence matrix ─────────────────────────────────────────────────────────

/**
 * Build a file-symbol incidence matrix M[file, symbol] = 1
 * where file imports symbol (via forward symbol edges).
 *
 * Returns CSR matrix plus the file list for row-index mapping.
 */
export function buildIncidenceMatrix(symbolGraph: InMemorySymbolGraph): {
  matrix: SparseCSR;
  fileList: string[];
} {
  const fileList = Array.from(symbolGraph.byFile.keys());
  const fileIndex = new Map<string, number>();
  for (let i = 0; i < fileList.length; i++) fileIndex.set(fileList[i], i);

  // Build contiguous column index from symbol IDs
  const symbolIds = Array.from(symbolGraph.symbols.keys());
  const symIdToCol = new Map<number, number>();
  for (let i = 0; i < symbolIds.length; i++) symIdToCol.set(symbolIds[i], i);

  const m = fileList.length;
  const n = symbolIds.length;

  // Collect entries: file -> set of imported symbol column indices
  const rowEntries: Set<number>[] = new Array(m);
  for (let i = 0; i < m; i++) rowEntries[i] = new Set();

  for (const [filePath, symIds] of symbolGraph.byFile) {
    const fileIdx = fileIndex.get(filePath);
    if (fileIdx === undefined) continue;

    for (const symId of symIds) {
      for (const edge of symbolGraph.forward.get(symId) ?? []) {
        const col = symIdToCol.get(edge.toSymbolId);
        if (col !== undefined) rowEntries[fileIdx].add(col);
      }
    }
  }

  // Count nnz and build CSR
  let nnz = 0;
  for (let i = 0; i < m; i++) nnz += rowEntries[i].size;

  const rowPtr = new Int32Array(m + 1);
  const colIdx = new Int32Array(nnz);
  const values = new Float64Array(nnz);

  let idx = 0;
  for (let row = 0; row < m; row++) {
    rowPtr[row] = idx;
    const sorted = Array.from(rowEntries[row]).sort((a, b) => a - b);
    for (const col of sorted) {
      colIdx[idx] = col;
      values[idx] = 1.0;
      idx++;
    }
  }
  rowPtr[m] = nnz;

  return { matrix: { rows: m, cols: n, rowPtr, colIdx, values }, fileList };
}

// ── Randomized SVD ───────────────────────────────────────────────────────────

/**
 * Halko-Martinsson-Tropp randomized truncated SVD.
 *
 * 1. Random Gaussian Omega (n x (rank + oversampling))
 * 2. Y = M * Omega (sparse mat-vec)
 * 3. Power iteration: Y = M * (M^T * Y)
 * 4. QR of Y -> Q
 * 5. B = Q^T * M (dense, small)
 * 6. SVD of B via Jacobi on B * B^T
 *
 * Returns file embeddings (rows of Q * U_B * diag(S)) and singular values.
 */
export function randomizedSVD(
  matrix: SparseCSR,
  rank: number = LSA_RANK,
  oversampling: number = LSA_OVERSAMPLING,
  powerIterations: number = LSA_POWER_ITERATIONS,
): { U: Float64Array; S: Float64Array; rank: number } {
  const m = matrix.rows;
  const n = matrix.cols;
  const k = Math.min(rank + oversampling, Math.min(m, n));
  const actualRank = Math.min(rank, k);

  if (m === 0 || n === 0 || k === 0) {
    return { U: new Float64Array(0), S: new Float64Array(0), rank: 0 };
  }

  // 1. Random Gaussian Omega: n x k
  const omega = new Float64Array(n * k);
  for (let i = 0; i < omega.length; i++) omega[i] = gaussianRandom();

  // 2. Y = M * Omega: m x k
  let Y = sparseMatDense(matrix, omega, k);

  // 3. Power iteration for improved approximation
  for (let p = 0; p < powerIterations; p++) {
    const Z = sparseTransposeMatDense(matrix, Y, k);
    Y = sparseMatDense(matrix, Z, k);
  }

  // 4. QR of Y -> Q: m x k
  const { Q } = qr(Y, m, k);

  // 5. B = Q^T * M: k x n (iterate sparse M rows)
  const B = new Float64Array(k * n);
  for (let row = 0; row < m; row++) {
    const start = matrix.rowPtr[row];
    const end = matrix.rowPtr[row + 1];
    for (let idx = start; idx < end; idx++) {
      const col = matrix.colIdx[idx];
      const val = matrix.values[idx];
      for (let i = 0; i < k; i++) {
        B[i * n + col] += Q[row * k + i] * val;
      }
    }
  }

  // 6. SVD of B via Jacobi on B * B^T (k x k)
  const BBt = new Float64Array(k * k);
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let dot = 0;
      for (let l = 0; l < n; l++) dot += B[i * n + l] * B[j * n + l];
      BBt[i * k + j] = dot;
      BBt[j * k + i] = dot;
    }
  }

  const { eigenvalues, eigenvectors } = jacobiEigen(BBt, k);

  // Sort eigenvalues descending, take top `actualRank`
  const indices = Array.from({ length: k }, (_, i) => i)
    .sort((a, b) => eigenvalues[b] - eigenvalues[a])
    .slice(0, actualRank);

  const S = new Float64Array(actualRank);
  for (let i = 0; i < actualRank; i++) {
    S[i] = Math.sqrt(Math.max(0, eigenvalues[indices[i]]));
  }

  // U_B truncated: k x actualRank (columns from eigenvectors)
  const UB = new Float64Array(k * actualRank);
  for (let j = 0; j < k; j++) {
    for (let i = 0; i < actualRank; i++) {
      UB[j * actualRank + i] = eigenvectors[j * k + indices[i]];
    }
  }

  // File embeddings: U = Q * UB * diag(S): m x actualRank
  const QUB = matmul(Q, m, k, UB, actualRank);
  const U = new Float64Array(m * actualRank);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < actualRank; j++) {
      U[i * actualRank + j] = QUB[i * actualRank + j] * S[j];
    }
  }

  return { U, S, rank: actualRank };
}

// ── High-level API ───────────────────────────────────────────────────────────

/**
 * Compute LSA file embeddings from the symbol graph.
 *
 * Returns null for codebases with fewer than LSA_MIN_FILES files
 * (too few for meaningful latent structure).
 */
export function computeFileEmbeddings(
  symbolGraph: InMemorySymbolGraph,
  rank: number = LSA_RANK,
): Map<string, Float64Array> | null {
  if (symbolGraph.byFile.size < LSA_MIN_FILES) return null;

  const { matrix, fileList } = buildIncidenceMatrix(symbolGraph);
  const { U, rank: actualRank } = randomizedSVD(matrix, rank);

  if (actualRank === 0) return null;

  const embeddings = new Map<string, Float64Array>();
  for (let i = 0; i < fileList.length; i++) {
    const row = U.subarray(i * actualRank, (i + 1) * actualRank);
    // Skip zero-norm rows (files with no imports)
    let norm = 0;
    for (let j = 0; j < actualRank; j++) norm += row[j] * row[j];
    if (norm > 1e-15) {
      embeddings.set(fileList[i], new Float64Array(row));
    }
  }

  return embeddings;
}

/**
 * Expand BM25F seeds with conceptually similar files via LSA cosine.
 *
 * 1. Compute centroid = weighted average of top-K seed embeddings
 * 2. Find non-seed files above LSA_COSINE_THRESHOLD
 * 3. Cap at LSA_MAX_EXPANSIONS, score at LSA_EXPANSION_DISCOUNT * min(seed scores)
 */
export function expandSeedsWithLSA(
  seedFiles: string[],
  seedScores: Map<string, number>,
  embeddings: Map<string, Float64Array>,
): { files: string[]; scores: Map<string, number> } {
  if (embeddings.size === 0 || seedFiles.length === 0) {
    return { files: seedFiles, scores: seedScores };
  }

  // Determine embedding dimension from any value
  const sampleEmb = embeddings.values().next().value;
  if (!sampleEmb) return { files: seedFiles, scores: seedScores };
  const dim = sampleEmb.length;

  // Compute weighted centroid of seed embeddings
  const centroid = new Float64Array(dim);
  let totalWeight = 0;

  for (const file of seedFiles) {
    const emb = embeddings.get(file);
    if (!emb) continue;
    const weight = seedScores.get(file) ?? 0;
    if (weight <= 0) continue;
    for (let i = 0; i < dim; i++) centroid[i] += weight * emb[i];
    totalWeight += weight;
  }

  if (totalWeight <= 0) return { files: seedFiles, scores: seedScores };
  for (let i = 0; i < dim; i++) centroid[i] /= totalWeight;

  // Compute cosine similarity for all non-seed files
  const seedSet = new Set(seedFiles);
  const candidates: Array<{ file: string; sim: number }> = [];

  for (const [file, emb] of embeddings) {
    if (seedSet.has(file)) continue;
    const sim = cosine(centroid, emb);
    if (sim >= LSA_COSINE_THRESHOLD) {
      candidates.push({ file, sim });
    }
  }

  if (candidates.length === 0) return { files: seedFiles, scores: seedScores };

  // Sort by similarity descending, cap at LSA_MAX_EXPANSIONS
  candidates.sort((a, b) => b.sim - a.sim);
  const expansions = candidates.slice(0, LSA_MAX_EXPANSIONS);

  // Assign score = LSA_EXPANSION_DISCOUNT * min(seed BM25F scores)
  let minSeedScore = Infinity;
  for (const score of seedScores.values()) {
    if (score < minSeedScore) minSeedScore = score;
  }
  const expansionScore = LSA_EXPANSION_DISCOUNT * minSeedScore;

  // Merge original seeds with expansions
  const mergedScores = new Map(seedScores);
  const mergedFiles = [...seedFiles];

  for (const { file } of expansions) {
    mergedFiles.push(file);
    mergedScores.set(file, expansionScore);
  }

  return { files: mergedFiles, scores: mergedScores };
}
