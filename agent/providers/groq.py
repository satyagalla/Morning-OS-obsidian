import os
from groq import Groq
from .base import LLMProvider


class GroqProvider(LLMProvider):
    def __init__(self, model: str, api_key_env: str = "GROQ_API_KEY", **kwargs):
        self.model = model
        self.client = Groq(api_key=os.environ[api_key_env])

    def generate(self, system: str, user: str) -> str:
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.7,
            max_tokens=2048,
        )
        return response.choices[0].message.content
