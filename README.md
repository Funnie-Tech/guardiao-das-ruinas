# Guardião das Ruínas

Jogo isométrico de ação em pixel art (Phaser 3). O herói, o golem e as salas são modelados e animados no Blender
e convertidos em sprites com mapa de normais.

## Screenshots

<table>
  <tr>
    <td width="25%" align="center"><a href="https://github.com/user-attachments/assets/582a4eb9-b83c-4a51-829e-69e9e6114160"><img src="https://github.com/user-attachments/assets/582a4eb9-b83c-4a51-829e-69e9e6114160" width="240" alt="Tela de título"></a><br><sub>Tela de título</sub></td>
    <td width="25%" align="center"><a href="https://github.com/user-attachments/assets/e5d5d900-40fc-46bb-a18a-8e91c57bd0e2"><img src="https://github.com/user-attachments/assets/e5d5d900-40fc-46bb-a18a-8e91c57bd0e2" width="240" alt="Entrada das ruínas"></a><br><sub>Entrada das ruínas</sub></td>
    <td width="25%" align="center"><a href="https://github.com/user-attachments/assets/a29652cd-48db-42e4-a1e9-8f552c13f93f"><img src="https://github.com/user-attachments/assets/a29652cd-48db-42e4-a1e9-8f552c13f93f" width="240" alt="Giro no salão"></a><br><sub>Giro no salão</sub></td>
    <td width="25%" align="center"><a href="https://github.com/user-attachments/assets/648049ac-20ad-432f-b1aa-2ffebffc154c"><img src="https://github.com/user-attachments/assets/648049ac-20ad-432f-b1aa-2ffebffc154c" width="240" alt="Enigma das runas"></a><br><sub>Enigma das runas</sub></td>
  </tr>
  <tr>
    <td width="25%" align="center"><a href="https://github.com/user-attachments/assets/27d98f2c-6625-4c0e-a134-e68ad4820948"><img src="https://github.com/user-attachments/assets/27d98f2c-6625-4c0e-a134-e68ad4820948" width="240" alt="Cripta"></a><br><sub>Cripta</sub></td>
    <td width="25%" align="center"><a href="https://github.com/user-attachments/assets/cfd1b82d-1436-4d4e-88d1-168fe3227750"><img src="https://github.com/user-attachments/assets/cfd1b82d-1436-4d4e-88d1-168fe3227750" width="240" alt="Enigma das placas"></a><br><sub>Enigma das placas</sub></td>
    <td width="25%" align="center"><a href="https://github.com/user-attachments/assets/47486a22-e65b-4d45-af5c-435753e614c3"><img src="https://github.com/user-attachments/assets/47486a22-e65b-4d45-af5c-435753e614c3" width="240" alt="Estocada na galeria"></a><br><sub>Estocada na galeria</sub></td>
    <td width="25%" align="center"><a href="https://github.com/user-attachments/assets/7eee7574-8ae4-4c8e-a3fa-d05ecdf61026"><img src="https://github.com/user-attachments/assets/7eee7574-8ae4-4c8e-a3fa-d05ecdf61026" width="240" alt="O golem desperta"></a><br><sub>O golem desperta</sub></td>
  </tr>
  <tr>
    <td width="25%" align="center"><a href="https://github.com/user-attachments/assets/3167032f-05a4-452f-8161-e58adee83adf"><img src="https://github.com/user-attachments/assets/3167032f-05a4-452f-8161-e58adee83adf" width="240" alt="O aviso do guardião"></a><br><sub>O aviso do guardião</sub></td>
    <td width="25%" align="center"><a href="https://github.com/user-attachments/assets/5d91be40-637c-48f6-af58-27cc5ba60da7"><img src="https://github.com/user-attachments/assets/5d91be40-637c-48f6-af58-27cc5ba60da7" width="240" alt="Onda de choque"></a><br><sub>Onda de choque</sub></td>
    <td width="25%" align="center"><a href="https://github.com/user-attachments/assets/26d4c8fb-564a-4edd-8362-3bde04453471"><img src="https://github.com/user-attachments/assets/26d4c8fb-564a-4edd-8362-3bde04453471" width="240" alt="Golpe do golem"></a><br><sub>Golpe do golem</sub></td>
    <td width="25%" align="center"><a href="https://github.com/user-attachments/assets/bbcc6e92-7532-4059-8d7f-a79b8fd5442f"><img src="https://github.com/user-attachments/assets/bbcc6e92-7532-4059-8d7f-a79b8fd5442f" width="240" alt="Vitória"></a><br><sub>Vitória</sub></td>
  </tr>
</table>

## Estrutura

- `game/` — o jogo (arquivos estáticos). Local: `docker compose up -d --build` → http://localhost:8377
- `scripts/` — geração dos assets: `render_iso.py` (herói), `render_golem.py`, `render_rooms.py` (Blender headless),
  `pixelate.py` (renders → sprites), `gen_audio.sh` (ElevenLabs).
- `index.html` + `sprites/` — visualizador das animações do herói.

## Produção

https://guardiao-das-ruinas.funnie.dev — git stack `guardiao-das-ruinas` no Dockhand da vps-bart (`compose.prod.yaml`,
build no deploy). O container fica só na rede interna `guardiao-network`, compartilhada apenas com o proxy (NPM).
Deploy: merge na `main`, depois sync + deploy da stack no Dockhand.
