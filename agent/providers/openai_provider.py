import os
from openai import OpenAI
from .base import LLMProvider


class OpenAIProvider(LLMProvider):
    def __init__(self, model: str, api_key_env: str = "OPENAI_API_KEY", base_url: str | None = None, **kwargs):
        self.model = model
        self.client = OpenAI(api_key=os.environ[api_key_env], base_url=base_url)

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
