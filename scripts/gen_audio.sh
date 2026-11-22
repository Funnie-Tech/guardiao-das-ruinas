#!/bin/bash
# Generate the game's sound effects and music with the ElevenLabs CLI (needs ELEVENLABS_API_KEY).
# Files that already exist are skipped, so re-running only fills the gaps and spends no extra credits.
out="${1:-game/assets/audio}"; mkdir -p "$out"
sfx() {  # name seconds prompt [loop]
  [ -s "$out/$1.mp3" ] && return
  elevenlabs text-to-sound-effects convert --text "$3" --duration-seconds "$2" --prompt-influence 0.5 \
    --loop "${4:-false}" -o "$out/$1.mp3" -q && echo "ok $1" || echo "FAILED $1"
}
music() {  # name milliseconds prompt
  [ -s "$out/$1.mp3" ] && return
  # a JSON body, because the flag form insists on a full composition plan
  python3 -c 'import json, sys; print(json.dumps({"prompt": sys.argv[1], "music_length_ms": int(sys.argv[2]), "force_instrumental": True}))' "$3" "$2" \
    | elevenlabs music compose --json - -o "$out/$1.mp3" -q && echo "ok $1" || echo "FAILED $1"
}
sfx swing_light 0.6 "Quick thin sword thrust whoosh, sharp fencing lunge cutting the air, no impact"
sfx swing_heavy 0.9 "Heavy greatsword swing whoosh, powerful blade cutting through the air, deep and weighty, no impact"
sfx swing_spin  1.0 "Sword whirling in a full circle, fast spinning blade whoosh, sweeping wind"
sfx hit_stone   0.6 "Steel sword blade striking solid stone, sharp metallic clang with a rock crack, punchy"
sfx hit_heavy   0.9 "Massive greatsword smashing into a stone boulder, deep crunch, cracking rock and falling debris, cinematic impact"
sfx jump        0.5 "Armored warrior leaping, quick cloth and leather whoosh with light armor rattle"
sfx land        0.5 "Armored boots landing on a stone floor, short thud with light metal rattle"
sfx hero_hurt   0.6 "Young male warrior short pain grunt as he is hit, armor clank"
sfx golem_roar  2.8 "Giant stone golem roar, deep rumbling monstrous growl with grinding rocks, cavernous echo"
sfx golem_step  0.6 "Giant stone creature heavy footstep, deep thud on a stone floor with small falling debris"
sfx golem_swipe 0.8 "Huge heavy stone arm swinging through the air, deep low whoosh with grinding rock"
sfx golem_slam  1.6 "Colossal stone fists slamming the ground, earth shaking impact, sub bass boom, rumble and scattering debris"
sfx magic_charge 1.5 "Fire magic charging up, rising ember energy hum with crackling flames, ominous build up"
sfx magic_burst 1.2 "Fiery magic eruption bursting out of the ground, explosive fire blast with rock debris"
sfx golem_hurt  0.7 "Stone cracking and chipping, short rock fracture with a deep creature grunt"
sfx golem_death 4.0 "Giant stone golem collapsing into a pile of rubble, long rock avalanche, deep dying groan, dust settling"
sfx ui_move     0.5 "Soft medieval menu tick, small wooden click"
sfx ui_confirm  0.8 "Fantasy game menu confirm, short sword unsheathe shing with a soft bright chime"
sfx victory     4.5 "Triumphant medieval fanfare, heroic brass and drums victory stinger, grand ending"
sfx defeat      3.5 "Somber defeat stinger, low strings and a slow funeral drum hit, dark fantasy"
sfx parry       0.7 "Sharp metallic sword parry, bright ringing steel clang deflecting a heavy stone blow"
sfx roll        0.6 "Armored warrior dodge roll on a stone floor, quick tumble, cloth and leather whoosh with light armor rattle"
sfx hero_death  1.6 "Armored warrior collapsing face down on a stone floor, heavy body thud, sword clattering on stone"
sfx charge_ready 0.9 "Bright magical shimmer as a sword becomes fully charged with power, rising sparkle ending in a clear chime"
sfx bolt        0.6 "Arcane magic bolt cast from a sword, sharp crystalline zap with a short whoosh"
sfx potion      0.8 "Drinking a potion, glass bottle uncorked, quick gulp and a soft magical sparkle"
sfx door        1.6 "Heavy ancient stone door grinding open, deep rumble, dust falling"
sfx solved      1.6 "Ancient puzzle solved, mystical rising chime with a deep resonant stone tone"
sfx ambience   12.0 "Night wind blowing through ancient abandoned stone ruins, distant low rumble, eerie and calm" true
music music_menu   60000 "Majestic fantasy adventure title theme. Solo french horn melody over harp arpeggios and warm strings, soft choir pad, distant timpani. Mysterious ancient ruins at dusk, hopeful, noble, grand. Medieval orchestral, slow tempo, cinematic. Instrumental, loops smoothly."
music music_battle 96000 "Grand epic orchestral boss battle theme for a fantasy adventure. Heroic brass fanfare melody, soaring strings, pounding taiko and timpani, driving string ostinato, choir swells, anvil hits. D minor, 150 BPM, relentless, dangerous and triumphant, cinematic medieval. Instrumental, no intro fade, loops smoothly."
music music_explore 90000 "Dark atmospheric dungeon exploration music for ancient ruins at night. Low sustained strings, distant choir pad, sparse harp and dulcimer notes, slow deep drum pulse, mysterious and tense but adventurous. Medieval fantasy, slow tempo, cinematic. Instrumental, loops smoothly."
