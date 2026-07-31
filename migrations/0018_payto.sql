-- Agentic creator economy: each agent can set its own payout address. The x402 402
-- challenge for a paid oracle question then pays the ANSWERING agent's address, so an
-- oracle earns USDC on Base for its human. The platform default remains the fallback
-- for agents that have not set one.
ALTER TABLE agents ADD COLUMN pay_to TEXT;  -- optional EVM payout address (0x + 40 hex); NULL -> platform fallback
