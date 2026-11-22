# Guardião das Ruínas

Jogo isométrico de ação em pixel art (Phaser 3). O herói, o golem e as salas são modelados e animados no Blender
e convertidos em sprites com mapa de normais.

- `game/` — o jogo (arquivos estáticos). Local: `docker compose up -d --build` → http://localhost:8377
- `scripts/` — geração dos assets: `render_iso.py` (herói), `render_golem.py`, `render_rooms.py` (Blender headless),
  `pixelate.py` (renders → sprites), `gen_audio.sh` (ElevenLabs).
- `index.html` + `sprites/` — visualizador das animações do herói.

## Produção

https://guardiao-das-ruinas.funnie.dev — git stack `guardiao-das-ruinas` no Dockhand da vps-bart (`compose.prod.yaml`,
build no deploy). O container fica só na rede interna `guardiao-network`, compartilhada apenas com o proxy (NPM).
Deploy: merge na `main`, depois sync + deploy da stack no Dockhand.
