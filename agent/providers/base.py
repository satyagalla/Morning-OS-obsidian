from abc import ABC, abstractmethod


class LLMProvider(ABC):
    @abstractmethod
    def generate(self, system: str, user: str) -> str:
        """Send system + user messages, return raw text response."""
        ...
