# Contributing

Pull requests welcome. The most useful contributions:

- **Framework examples** — add an example for a framework not yet covered (AutoGen, smolagents, LlamaIndex, etc.) in `examples/`
- **Bug fixes** — if an endpoint response shape changed or a step broke
- **Python x402 improvements** — the EIP-3009 signing in `agent.py` works but a more robust implementation using an x402 library is welcome

## Adding a framework example

1. Copy the structure from `examples/langgraph_agent.py` or `examples/crewai_agent.py`
2. Replace placeholder wallet addresses with `0x0000000000000000000000000000000000000001`
3. Replace placeholder LEIs with `EXAMPLE_LEI_00000000000`
4. Do not include real wallet addresses, private keys, or API keys
5. Add a row to the framework table in `README.md`

## Running locally

```bash
npm install && cp .env.example .env
# add PRIVATE_KEY and RECIPIENT_ADDRESS
npm start        # TypeScript
python3 agent.py # Python (pip install httpx python-dotenv eth-account)
```

Demo mode (no wallet): `npm start` with no `.env` runs the full loop with simulated x402 payments.

## What not to include

- Real wallet addresses or private keys
- API keys or tokens
- Named data providers or oracle sources (describe by function only)
- Competitor names
