import os
from google import genai
from .base import LLMProvider


class GeminiProvider(LLMProvider):
    def __init__(self, model: str, api_key_env: str = "GEMINI_API_KEY", **kwargs):
        self.model = model
        self.client = genai.Client(api_key=os.environ[api_key_env])

    def generate(self, system: str, user: str) -> str:
        response = self.client.models.generate_content(
            model=self.model,
            contents=user,
            config=genai.types.GenerateContentConfig(
                system_instruction=system,
                temperature=0.7,
                max_output_tokens=2048,
            ),
        )
        return response.text
