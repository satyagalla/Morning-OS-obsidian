import boto3
from .base import LLMProvider


class BedrockProvider(LLMProvider):
    def __init__(self, model: str, region: str, **kwargs):
        self.model = model
        self.client = boto3.client("bedrock-runtime", region_name=region)

    def generate(self, system: str, user: str) -> str:
        response = self.client.converse(
            modelId=self.model,
            messages=[{"role": "user", "content": [{"text": user}]}],
            system=[{"text": system}],
            inferenceConfig={"maxTokens": 2048, "temperature": 0.7},
        )
        return response["output"]["message"]["content"][0]["text"]
