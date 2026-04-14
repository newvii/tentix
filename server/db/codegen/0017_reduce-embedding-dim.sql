ALTER TABLE "tentix"."knowledge_base" ALTER COLUMN "embedding" SET DATA TYPE tentix.vector(1024);

-- 重建 IVF 索引以匹配新的 1024 维
DROP INDEX IF EXISTS "tentix"."idx_kb_embedding_halfvec_ivf";
CREATE INDEX idx_kb_embedding_halfvec_ivf ON tentix.knowledge_base USING ivfflat (((embedding)::tentix.halfvec(1024)) tentix.halfvec_cosine_ops) WITH (lists = 100);