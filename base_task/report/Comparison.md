# LSTM vs. Transformer

Both models were trained and evaluated under the same experimental setup to ensure a fair comparison.

- **Training Dataset:** Same training split
- **Validation Dataset:** Same validation split
- **Test Dataset:** Same unseen test window
- **Task:** Multi-step weather forecasting on the Jena Climate dataset
- **Evaluation Metrics:** R² Score, MAE, MSE, and Huber Loss

## Performance Comparison

| Metric | LSTM | Transformer |
|--------|------:|------------:|
| **R² Score** | **0.9560** | **0.9564** |
| **MAE** | **0.1386** | **0.1336** |
| **MSE** | **0.0415** | **0.0412** |
| **Huber Loss** | **0.0206** | **0.0204** |

The Transformer achieved slightly better performance across all evaluation metrics while requiring less training time than the custom LSTM implementation.

## Why Attention Helps Sequence Modeling

Unlike an LSTM, which processes the sequence one time step at a time, a Transformer uses **self-attention** to compare every time step with every other time step in the input sequence. This allows the model to identify important temporal relationships regardless of the distance between observations. For weather forecasting, this helps the model capture both short-term fluctuations and longer-term trends more effectively. The LSTM model required a longer duration to train compared to the training time of the Transformer model. This is primarily because LSTMs process sequences sequentially, whereas Transformers can process all time steps in parallel (multi-head attention), leading to more efficient GPU utilization.

## Recurrence vs. Attention

| LSTM (Recurrence) | Transformer (Attention) |
|-------------------|-------------------------|
| Processes one time step at a time. | Processes the entire sequence simultaneously. |
| Information is propagated through hidden states. | Information flows directly between all time steps via self-attention. |
| Difficult to capture very long-range dependencies. | Naturally captures long-range dependencies. |
| Limited parallelism during training. | Highly parallelizable, resulting in faster training. |
| Consumes Lower memory .| Consumes higher memory .|
| O(n) Time complexity | O(n^2) Time complexity .|

## When LSTMs Are Still Useful

Although the Transformer performed better in this project, LSTMs remain a strong choice in several scenarios:

- Small datasets with limited training examples.
- Resource constrained environments where memory usage is important.
- Short sequence prediction tasks with strong local temporal dependencies.

## When Transformers Perform Better

Transformers are generally preferred when:

- Long input sequences must be modeled.
- Long-range dependencies are important.
- Faster training through parallel computation is desired.
- Large datasets are available for training.
- Higher predictive performance is required for complex sequence modeling tasks.

## Conclusion

Under the same training and evaluation conditions, the custom Transformer slightly outperformed the custom LSTM on the Jena Climate forecasting task. In addition to achieving lower prediction errors, the Transformer trained faster due to its parallel attention mechanism. While both models demonstrated excellent forecasting performance, the Transformer provided the best balance between accuracy and training efficiency for this dataset.
