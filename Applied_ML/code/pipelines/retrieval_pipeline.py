from langchain_core.documents import Document
from langchain_ollama import ChatOllama
from langchain_huggingface import HuggingFaceEmbeddings
from sentence_transformers import CrossEncoder
from langchain_classic.retrievers import EnsembleRetriever, BM25Retriever
from langchain_chroma import Chroma
from langchain_core.messages import HumanMessage
from prompts import *
from pydantic import BaseModel
from typing import List, Literal
import numpy as np

DB_FILEPATH = "../vector_db/db01"
TOP_K = 5
CONFIDENCE_THRESHOLD = 0.60
SAFE_CONTEXT_WINDOW = 5000

class QueryClassifier(BaseModel):
    type: str

class Claims(BaseModel):
    claims : List[str]
    is_dangerous : bool
    is_missing_citations : bool
    changes_to_be_made : List[str]

class Generation(BaseModel):
    answer : str
    sources : List[str]
    row_ids : List[int | str]
    confidence_score : float

llm = ChatOllama(model="gemma4")
cross_encoder = CrossEncoder("BAAI/bge-reranker-v2-m3")

embedding_model = HuggingFaceEmbeddings(model_name="BAAI/BGE-M3")
vectorstore = Chroma(
    persist_directory=DB_FILEPATH,
    embedding_function=embedding_model,
    collection_metadata={'hnsw:space':"cosine"}
)

data = vectorstore.get()
chunks = []

for content, metadata in zip(data["documents"], data["metadatas"]):
    chunks.append(Document(page_content=content, metadata=metadata))

vector_retriever = vectorstore.as_retriever(search_kwargs={"k":6})

keyword_retriever = BM25Retriever.from_documents(chunks)
keyword_retriever.k = 6

hybrid_Retriever = EnsembleRetriever(retrievers=[vector_retriever, keyword_retriever], weights=[0.6, 0.4])

def classifyQuery(query):
    mesg = "QUERY TO BE CLASSIFIED:\n"
    mesg += query

    resp = llm.with_structured_output(QueryClassifier).invoke([query_classifier_sys_msg, HumanMessage(mesg[:SAFE_CONTEXT_WINDOW])])
    type_of_query = resp.type
    print(type_of_query)
    return type_of_query

def rerank(query, chunks):
    combined = []
    for chunk in chunks:
        combined.append((query, chunk.page_content))

    scores = cross_encoder.predict(combined)
    score_chunks = list(zip(chunks, scores))

    sorted_chunks = sorted(score_chunks, key = lambda x: x[1], reverse=True)
    reranked = [chunk for chunk, _ in sorted_chunks[:TOP_K]]
    scores = [ score for _, score in sorted_chunks[:TOP_K]]
    return reranked, scores 

def verify_final_answer(query, answer):
    ans = HumanMessage(f"FINAL ANSWER \n {answer}"[:SAFE_CONTEXT_WINDOW])
    resp = llm.with_structured_output(Claims).invoke([final_ans_sys_msg, ans])  

    if resp.is_dangerous or resp.is_missing_citations:
        problems = f"ANSWER: \n {answer}"
        problems += "PROBLEMS IN THE ANSWER TO FIX:\n"
        for problem in resp.changes_to_be_made:
            problems += problem
            problems += "\n"
        problems += f"\n USER QUERY {query}"
        resp = llm.with_structured_output(Generation).invoke([regenerate_sys_msg, HumanMessage(problems[:SAFE_CONTEXT_WINDOW])])
        return resp
    else:
        return 0


def retrieve(query):
    rag_respone = {}
    caution = False

    # Classifying the Query
    type_of_query = classifyQuery(query)

    if type_of_query == "SAFE":
        pass
    elif type_of_query == "DANGEROUS":
        return {"content" : query_dangerous,
                "confidence" : 0,
                "caution" : True
        }
        
    elif type_of_query == "EMERGENCY":
        return {"content" : "Your question appears to describe a situation that may require immediate medical attention.\nseek immediate medical care or contact your local emergency medical services without delay",
                "confidence" : 0,
                "caution" : True
        }

    else:
        caution = True

    docs_and_scores = vectorstore.similarity_search_with_score(query, k=10)
    vector_scores = [
        1-score
        for _, score in docs_and_scores
    ]

    chunks = hybrid_Retriever.invoke(query)
    reranked, scores = rerank(query, chunks)

    # Normalization - Turinng the Scores into a range of 0 to 1
    scores = 1/(1+np.exp(-np.array(scores)))

    avg_vector_score = sum(vector_scores)/len(vector_scores)
    avg_rerank_score = sum(scores)/len(scores)

    msg = ""

    msg = f"USER QUERY:\n{query}"

    msg += "CONTEXTS:"
    for i, chunk in enumerate(reranked, 1):
        msg += (
            f"\nCONTEXT: {chunk.metadata.get('row_id')}"
            f"\nSOURCE: {chunk.metadata.get('source')}"
        )
        msg += chunk.page_content

    hum_msg = HumanMessage(msg[:SAFE_CONTEXT_WINDOW])

    resp = llm.with_structured_output(Generation).invoke([system_msg_generation, hum_msg])
    
    # Confidence Estimation using Similarity Score and LLM self reflection and Reranking Score
    confidence = float(0.6 * resp.confidence_score + 0.2 * avg_rerank_score + 0.2 * avg_vector_score)

    print("Overall Confidence", confidence)
    if confidence > CONFIDENCE_THRESHOLD:
        corrected_resp = verify_final_answer(query, resp.answer)
        print("Verified", corrected_resp)

        if corrected_resp:
            rag_respone["sources"] = corrected_resp.sources
            rag_respone["confidence"] = corrected_resp.confidence
            rag_respone["content"] = corrected_resp.answer
            rag_respone["caution"] = caution
        else:   
            rag_respone["sources"] = resp.sources
            rag_respone["confidence"] = confidence
            rag_respone["content"] = resp.answer
            rag_respone["caution"] = caution
        return rag_respone
    else:
        rag_respone["confidence"] = confidence
        rag_respone["content"] = lack_of_confidence
        rag_respone["caution"] = caution
        return rag_respone


if __name__ == "__main__":
    print(retrieve("What lifestyle changes help hypertension?"))
    
