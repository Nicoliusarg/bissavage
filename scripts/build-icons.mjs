// scripts/build-icons.mjs
import * as fs from "node:fs/promises";

// Helper para URLs del CDN de Wowhead
const icon = (key) => `https://wow.zamimg.com/images/wow/icons/medium/${key}.jpg`;

// Íconos de CLASE (IDs oficiales 1..13)
const classes = {
  1:  { id: 1,  name: "Guerrero",                 icon: icon("class_warrior") },
  2:  { id: 2,  name: "Paladín",                  icon: icon("class_paladin") },
  3:  { id: 3,  name: "Cazador",                  icon: icon("class_hunter") },
  4:  { id: 4,  name: "Pícaro",                   icon: icon("class_rogue") },
  5:  { id: 5,  name: "Sacerdote",                icon: icon("class_priest") },
  6:  { id: 6,  name: "Caballero de la Muerte",   icon: icon("class_deathknight") },
  7:  { id: 7,  name: "Chamán",                   icon: icon("class_shaman") },
  8:  { id: 8,  name: "Mago",                     icon: icon("class_mage") },
  9:  { id: 9,  name: "Brujo",                    icon: icon("class_warlock") },
  10: { id: 10, name: "Monje",                    icon: icon("class_monk") },
  11: { id: 11, name: "Druida",                   icon: icon("class_druid") },
  12: { id: 12, name: "Cazador de Demonios",      icon: icon("class_demonhunter") },
  13: { id: 13, name: "Evocador",                 icon: icon("class_evoker") }
};

// Íconos de RAZA (core – opcional; se puede ampliar luego)
const races = {
  1:  { id: 1,  name: "Humano",              icon: icon("race_human_male") },
  2:  { id: 2,  name: "Orco",                icon: icon("race_orc_male") },
  3:  { id: 3,  name: "Enano",               icon: icon("race_dwarf_male") },
  4:  { id: 4,  name: "Elfo de la Noche",    icon: icon("race_nightelf_male") },
  5:  { id: 5,  name: "No-muerto",           icon: icon("race_undead_male") },
  6:  { id: 6,  name: "Tauren",              icon: icon("race_tauren_male") },
  7:  { id: 7,  name: "Gnomo",               icon: icon("race_gnome_male") },
  8:  { id: 8,  name: "Trol",                icon: icon("race_troll_male") },
  9:  { id: 9,  name: "Goblin",              icon: icon("race_goblin_male") },
  10: { id: 10, name: "Elfo de Sangre",      icon: icon("race_bloodelf_male") },
  11: { id: 11, name: "Draenei",             icon: icon("race_draenei_male") },
  22: { id: 22, name: "Huargen",             icon: icon("race_worgen_male") },
  25: { id: 25, name: "Pandaren",            icon: icon("race_pandaren_male") }
};

// Escribimos el JS global que consume tu index.html
const out = `window.WOW_ICONS=${JSON.stringify({ classes, races })};\n`;
await fs.writeFile("wow-icons.js", out, "utf8");
console.log("✔ Generado wow-icons.js (estático via Wowhead CD
