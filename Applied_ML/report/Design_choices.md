# TrustyMed — Design Choices

## Context Window Management

| Choice | Rationale |
|---|---|
| Hard truncation to `SAFE_CONTEXT_WINDOW` (5000 chars) before every LLM call | We prevent hitting the Context Window of the LLM. We Limit the Prompt Size by this method|


## Reranking

| Choice | Rationale |
|---|---|
| Two-stage retrieval: broad hybrid retrieval → cross-encoder rerank | Bi-encoder/BM25 retrieval is fast but scores query and document independently, so it's better at recall than precision; the cross-encoder (bge-reranker-v2-m3) re-scores the smaller candidate set jointly for better top-k precision |
| Sigmoid-normalizing rerank scores | Cross-encoder outputs are raw logits, not bounded 0–1 — normalizing puts them on the same scale as cosine similarity so they can be combined in the confidence formula |
| Reranking cuts candidates down to `TOP_K=5` | Limits what actually reaches the generation prompt, keeping the context window usage predictable and the signal-to-noise ratio high |

## Confidence Pipeline

| Choice | Rationale |
|---|---|
| Blended confidence: 0.6 × LLM self-confidence + 0.2 × rerank avg + 0.2 × vector avg | LLM self-reported confidence alone is known to be poorly calibrated/overconfident; anchoring it to two independent retrieval-quality signals grounds the estimate in something measurable |
| Fixed threshold (`CONFIDENCE_THRESHOLD = 0.60`) with an explicit fallback message | Prevents a low-grounding answer from reaching the user framed as if it were reliable — fails closed rather than open |
| Confidence computed *before* the verification step, not after | Cheap answers get filtered out before spending an extra LLM call on claim verification/regeneration |

## Query Classification

| Choice | Rationale |
|---|---|
| Upfront classification into SAFE / DANGEROUS / EMERGENCY / other | Acts as a cheap gate before any retrieval or generation compute is spent — emergencies get a fixed, immediate safety message rather than a generated one |
| EMERGENCY and DANGEROUS short-circuit the entire pipeline | Avoids ever letting the LLM freeform a response to a medical emergency or unsafe query — the response is a fixed string, not model output |
| Unrecognized/ambiguous classifier output sets a `caution` flag but still proceeds | Fails permissive rather than blocking legitimate queries the classifier didn't cleanly bucket, while still flagging the response as needing extra care downstream |

## Answer Verification

| Choice | Rationale |
|---|---|
| Post-hoc claim check (`verify_final_answer`) separate from the original generation call | Treats generation and verification as two different jobs — the model that verifies isn't anchored to its own generation reasoning trace, closer to a second opinion |
| Structured `Claims` schema (`is_dangerous`, `is_missing_citations`, `changes_to_be_made`) | Makes the verification output machine-actionable instead of free text — the regeneration prompt is built directly from `changes_to_be_made` |
| Regeneration only triggered conditionally (`is_dangerous or is_missing_citations`) | Avoids the cost of a second generation call when the first answer already passes; only pays for regeneration when there's an actual finding |

## Batch Processing

| Choice | Rationale |
|---|---|
| Fixed batch size (8) for `vectorstore.add_documents` | Keeps embedding memory usage bounded regardless of corpus size — avoids trying to embed the entire MedQuAD dataset or a large PDF in one call |
| `torch.cuda.empty_cache()` after every batch | Actively releases GPU memory between batches rather than relying on Python/CUDA to reclaim it lazily, reducing risk of OOM over a long ingestion run |
| Same batching logic reused for both CSV and PDF ingestion | One code path to maintain rather than two separate memory-management strategies |

## CSV and PDF Ingestion Path / Knowledge Expansion

| Choice | Rationale |
|---|---|
| MedQuAD CSV parsed directly into `Document` objects (no chunking) | Each row is already a self-contained Q&A unit with a `focus_area`, so no chunking step adds value — chunking is only needed for unstructured, long-form documents |
| PDFs go through a heavier path: `partition_pdf(strategy="hi_res", infer_table_structure=True)` → `chunk_by_title` | PDFs can contain tables, headers, and layout information a plain text extractor would flatten; hi-res partitioning plus table inference preserves that structure before chunking |
| PDF ingestion (`ingestion_others`) is treated as a separate "knowledge expansion" step, run after the core CSV ingestion | Lets the base MedQuAD knowledge base come online first, with the PDF folder acting as an incremental/expandable knowledge source that can grow independently over time |
| `chunk_by_title` (not fixed-size) for PDFs specifically | Keeps semantically related content together — a chunk boundary lands on a section break rather than mid-paragraph |

## Other Choices Worth Noting

| Choice | Rationale |
|---|---|
| Structured outputs (Pydantic schemas) for every single LLM call — classification, generation, verification | Removes free-text parsing brittleness across the whole pipeline; every downstream consumer gets typed fields instead of needing to regex/parse prose |
| Hybrid retrieval (BM25 + dense vector) via `EnsembleRetriever`, weighted 0.6/0.4 toward vector | Dense embeddings alone can blur exact medical terms (drug names, dosages); BM25 catches literal keyword matches that a dense-only retriever might rank lower |
| `Chroma` with `hnsw:space="cosine"` explicitly set | Cosine similarity is the standard choice for normalized sentence-embedding spaces like BGE-M3 — makes the "1 − distance" conversion to similarity scores correct |
