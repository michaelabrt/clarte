/**
 * Embedding model loader using @huggingface/transformers (optional dependency).
 * Loads snowflake-arctic-embed-xs (384 dims, INT8 quantized) for local embedding generation.
 * Singleton: all callers await the same loading promise.
 */

export interface EmbeddingModel {
  embed(texts: string[]): Promise<Float32Array[]>;
  readonly dimensions: number;
  dispose(): Promise<void>;
}

const MODEL_ID = "Xenova/snowflake-arctic-embed-xs";
const DIMENSIONS = 384;

let pending: Promise<EmbeddingModel | null> | null = null;
let fallbackLogged = false;

async function doLoad(): Promise<EmbeddingModel | null> {
  try {
    const mod = (await import("@huggingface/transformers" as never as string)) as {
      pipeline: (task: string, model: string, options?: { dtype?: string }) => Promise<FeatureExtractionPipeline>;
    };
    const extractor = await mod.pipeline("feature-extraction", MODEL_ID, {
      dtype: "q8",
    });

    const instance: EmbeddingModel = {
      dimensions: DIMENSIONS,

      async embed(texts: string[]): Promise<Float32Array[]> {
        if (texts.length === 0) return [];
        const output = await extractor(texts, { pooling: "mean", normalize: true });
        const data = output.data as Float32Array;
        const results: Float32Array[] = [];
        for (let i = 0; i < texts.length; i++) {
          results.push(data.slice(i * DIMENSIONS, (i + 1) * DIMENSIONS));
        }
        return results;
      },

      async dispose(): Promise<void> {
        await extractor.dispose();
        pending = null;
      },
    };

    return instance;
  } catch {
    if (!fallbackLogged) {
      fallbackLogged = true;
      process.stderr.write(
        "[clarte] Semantic search unavailable; using BM25F only. " +
          "Install @huggingface/transformers for hybrid retrieval.\n",
      );
    }
    return null;
  }
}

/**
 * Load the embedding model. Returns null if @huggingface/transformers is not installed.
 * Singleton: all concurrent callers share the same loading promise.
 */
export function loadEmbeddingModel(): Promise<EmbeddingModel | null> {
  if (!pending) pending = doLoad();
  return pending;
}

/** Reset singleton state (for testing). */
export function _resetModelState(): void {
  pending = null;
  fallbackLogged = false;
}

// Internal type for the pipeline function returned by @huggingface/transformers
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
