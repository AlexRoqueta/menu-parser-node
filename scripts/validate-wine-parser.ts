import { parseWineText, toWineEntries, filterFoodNoise } from '../src/wineParser.js';

const SAMPLE_WINE_LIST = `
WINE LIST

SPARKLING
Veuve Clicquot Yellow Label, Brut, Champagne, France NV 145
Billecart-Salmon, Brut Reserve, Champagne, France NV 28 165
Bisol, Cartizze, Prosecco, Italy 2022 95

WHITE
Domaine Leflaive, Puligny-Montrachet, Burgundy, France 2019 285
Cloudy Bay, Sauvignon Blanc, Marlborough, New Zealand 2022 18 85
Trimbach, Riesling, Alsace, France 2020 75

RED
Antinori, Tignanello, Tuscany, Italy 2018 24 220
Caymus, Cabernet Sauvignon, Napa Valley, USA 2020 165
Bodega Catena Zapata, Malbec, Mendoza, Argentina 2021 110

ROSÉ
Domaine Tempier, Bandol Rosé, Provence, France 2022 95

DESSERT
Château d'Yquem, Sauternes, Bordeaux, France 2015 450

FORTIFIED
Taylor Fladgate, 20 Year Tawny Port, Douro, Portugal NV 75

SAKE
Dassai, 23 Junmai Daiginjo, Yamaguchi, Japan NV 220

APPETIZERS
Caesar Salad 18
New England Lobster Roll 32
`;

function main() {
  const parsed = parseWineText(SAMPLE_WINE_LIST, 'sample-wine-list.txt');
  const wines = filterFoodNoise(toWineEntries(parsed));

  console.log('=== Parsed sections ===');
  for (const sec of parsed.sections) {
    console.log(`[${sec.category}] ${sec.section} (${sec.items.length} items)`);
    for (const it of sec.items) {
      console.log(`  - ${it.producer ?? ''} | ${it.name} | vintage=${it.vintage} | varietal=${it.varietal ?? ''} | region=${it.region ?? ''} | country=${it.country ?? ''} | g=${it.glassPrice ?? '-'} b=${it.bottlePrice ?? '-'} p=${it.price ?? '-'}`);
    }
  }
  console.log(`\nTotal wines: ${wines.length}`);

  console.log('\n=== Sample entries ===');
  for (const w of wines.slice(0, 5)) {
    console.log(JSON.stringify(w, null, 2));
  }

  const assertions: Array<[string, boolean]> = [
    ['Sparkling section detected', parsed.sections.some((s) => s.category === 'sparkling')],
    ['White section detected', parsed.sections.some((s) => s.category === 'white')],
    ['Red section detected', parsed.sections.some((s) => s.category === 'red')],
    ['Rosé section detected', parsed.sections.some((s) => s.category === 'rose')],
    ['Dessert section detected', parsed.sections.some((s) => s.category === 'dessert')],
    ['Fortified section detected', parsed.sections.some((s) => s.category === 'fortified')],
    ['Sake section detected', parsed.sections.some((s) => s.category === 'sake')],
    ['Vintage parsed', wines.some((w) => w.vintage === 2019)],
    ['NV handled', wines.some((w) => w.vintage === null && /yquem|clicquot|taylor|dassai/i.test(`${w.producer ?? ''} ${w.name}`))],
    ['Varietal detected (cabernet sauvignon)', wines.some((w) => w.varietal === 'cabernet sauvignon')],
    ['Varietal detected (sauvignon blanc)', wines.some((w) => w.varietal === 'sauvignon blanc')],
    ['Region detected (napa valley)', wines.some((w) => /napa/i.test(w.region ?? ''))],
    ['Country detected (Argentina)', wines.some((w) => w.country === 'Argentina')],
    ['Glass+bottle prices captured', wines.some((w) => w.glassPrice && w.bottlePrice)],
    ['Food line excluded (Caesar Salad)', !wines.some((w) => /caesar/i.test(w.name))],
    ['Food line excluded (Lobster Roll)', !wines.some((w) => /lobster roll/i.test(w.name))]
  ];

  console.log('\n=== Assertions ===');
  let pass = 0;
  let fail = 0;
  for (const [label, result] of assertions) {
    const tag = result ? 'PASS' : 'FAIL';
    if (result) pass++;
    else fail++;
    console.log(`${tag}: ${label}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
