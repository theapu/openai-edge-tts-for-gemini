# openai-edge-tts-for-gemini
Openai api compatible Gemini text to speech

Build and run
```
docker compose up -d --build
```
Example usage:
```
jq -n --arg content "$(cat story.txt)" '{input: $content, voice: "Algenib"}'|curl -X POST http://192.168.255.181:23000/v1/audio/speech \
  -H "Authorization: Bearer <API Key for this rest API>" \
  -H "Content-Type: application/json" \
  -d @- \
  --output "test1.mp3"
```
See https://ai.google.dev/gemini-api/docs/speech-generation#voices for voice options.

amd64 docker image: https://hub.docker.com/repository/docker/theapu/openai-edge-tts-for-gemini-docker/general
  
