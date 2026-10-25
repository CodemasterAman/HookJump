# HookJump simulation results

30 songs, 10 users, 20 rounds, 6 songs/user/round, averaged over 10 seeds. Metrics are the mean of the last 5 rounds.

| Policy | Hit rate, round 1 (cold start) | Hook hit rate | Avg reward | Time to hook |
|---|---|---|---|---|
| Random start | 6.7% | 6.9% | -1.11 | 9.7s |
| Fixed 30% heuristic | 17.0% | 15.1% | -0.89 | 10.9s |
| Heatmap only (no RL) | 55.2% | 56.0% | 0.17 | 5.3s |
| Q-learning (personal) | 0.0% | 92.6% | 1.12 | 2.1s |
| Q-learning + community | 45.8% | 98.7% | 1.23 | 1.4s |
| HookJump (heatmap + community + personal) | 68.3% | 98.6% | 1.24 | 1.5s |

| Epsilon | Hook hit rate |
|---|---|
| 0.0 | 100.0% |
| 0.1 | 98.6% |
| 0.3 | 92.8% |
