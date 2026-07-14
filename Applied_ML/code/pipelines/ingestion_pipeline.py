from langchain_core.documents import Document
from langchain_ollama import ChatOllama
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_chroma.vectorstores import Chroma
import pandas as pd
import torch


DATA_FILEPATH = "../data/medquad.csv"
VECTORDB_PATH = "../vector_db/db01"
BATCH_SIZE = 8

# Initiating Embedding Models and Vector Store  
embedding_model = HuggingFaceEmbeddings(model_name="BAAI/bge-m3")
vectorstore = Chroma(embedding_function=embedding_model, collection_metadata={"hnsw:space":"cosine"}, persist_directory=VECTORDB_PATH)

def ingestion_pipeline():
    df = pd.read_csv(DATA_FILEPATH)

    documents = [
        Document(
            page_content=f"Question: {row['question']} Answer: {row['answer']} Disease: {row['focus_area']}",
            metadata={"source": row['source'], "row_id": idx, "disease": row["focus_area"]}
        )
        for idx, row in df.iterrows()
    ]
    c = 1
    for i in range(0, len(documents), BATCH_SIZE):
        print(f"#### Storing Batch {c}/{len(documents)//BATCH_SIZE} ####")
        batch = documents[i:i+BATCH_SIZE]
        vectorstore.add_documents(batch)
        torch.cuda.empty_cache()
        c+=1


    print("==== ADDED CHUNKS TO THE VECTOR STORE ====")

if __name__ == "__main__":
    ingestion_pipeline()

    