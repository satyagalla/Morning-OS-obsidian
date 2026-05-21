"""LLMClient with two named slots: intelligence (main briefing call) and fallback
(used when markdown parsing yields nothing). Providers are loaded dynamically by name
from vault_config.yaml — swap the provider key to change backends without touching code.
"""
import importlib
from .providers.base import LLMProvider

PROVIDER_MAP = {
    "bedrock": ("agent.providers.bedrock", "BedrockProvider"),
    "ollama": ("agent.providers.ollama", "OllamaProvider"),
    "openai": ("agent.providers.openai_provider", "OpenAIProvider"),
    "gemini": ("agent.providers.gemini", "GeminiProvider"),
    "groq": ("agent.providers.groq", "GroqProvider"),
}


def _create_provider(slot_config: dict) -> LLMProvider:
    provider_name = slot_config["provider"]
    module_path, class_name = PROVIDER_MAP[provider_name]
    mod = importlib.import_module(module_path)
    cls = getattr(mod, class_name)
    return cls(**slot_config)


class LLMClient:
    def __init__(self, config: dict):
        llm_config = config["llm"]
        self.intelligence = _create_provider(llm_config["intelligence"])
        self.fallback = _create_provider(llm_config["fallback"])

    def call_intelligence(self, system: str, user: str) -> str:
        return self.intelligence.generate(system, user)

    def call_fallback(self, system: str, user: str) -> str:
        return self.fallback.generate(system, user)
