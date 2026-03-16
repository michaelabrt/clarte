/**
 * Embedding model loader using @xenova/transformers (optional dependency).
 * Loads all-MiniLM-L6-v2 (384 dims) for local embedding generation.
 * Singleton: model loaded once, shared across the pipeline.
 */

export interface EmbeddingModel {
  embed(texts: string[]): Promise<Float32Array[]>;
  readonly dimensions: number;
  dispose(): Promise<void>;
}

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DIMENSIONS = 384;

let instance: EmbeddingModel | null = null;
let attempted = false;
let fallbackLogged = false;

/**
 * Load the embedding model. Returns null if @xenova/transformers is not installed.
 * Singleton: subsequent calls return the same instance.
 */
export async function loadEmbeddingModel(): Promise<EmbeddingModel | null> {
  if (attempted) return instance;
  attempted = true;

  try {
    const mod = (await import("@xenova/transformers" as never as string)) as {
      pipeline: (task: string, model: string) => Promise<FeatureExtractionPipeline>;
    };
    const extractor = await mod.pipeline("feature-extraction", MODEL_ID);

    instance = {
      dimensions: DIMENSIONS,

      async embed(texts: string[]): Promise<Float32Array[]> {
        if (texts.length === 0) return [];
        const output = await extractor(texts, { pooling: "mean", normalize: true });
        const data = output.data as Float32Array;
        const results: Float32Array[] = [];
        for (let i = 0; i < texts.length; i++) {
          // slice creates independent copies (safe after Tensor disposal)
          results.push(data.slice(i * DIMENSIONS, (i + 1) * DIMENSIONS));
        }
        return results;
      },

      async dispose(): Promise<void> {
        await extractor.dispose();
        instance = null;
        attempted = false;
      },
    };

    return instance;
  } catch {
    if (!fallbackLogged) {
      fallbackLogged = true;
      process.stderr.write(
        "[clarte] Semantic search unavailable; using BM25F only. " +
          "Install @xenova/transformers for hybrid retrieval.\n",
      );
    }
    return null;
  }
}

/** Reset singleton state (for testing). */
export function _resetModelState(): void {
  instance = null;
  attempted = false;
  fallbackLogged = false;
}

// Internal type for the pipeline function returned by @xenova/transformers
type FeatureExtractionPipeline = {
  (
    input: string | string[],
    options?: { pooling?: string; normalize?: boolean },
  ): Promise<{
    data: Float32Array;
    dims: number[];
  }>;
  dispose(): Promise<void>;
};
