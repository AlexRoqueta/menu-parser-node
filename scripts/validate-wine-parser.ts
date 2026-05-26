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

const NOISY_WINE_LIST = `
WINE LIST

RED
Acrobat, Pinot Noir, Russian River Valley, CA 2023 179
201795
201974
202082
Adelaida District, CA 2020 100
Sea Smoke, Pinot Noir, Sta. Rita Hills, USA 2021 245
123456
Bin #4502
Page 12

WHITE
Far Niente, Chardonnay, Napa Valley, CA 2022 185
2023 195
CA
USA
9999
`;

const GLUED_NUMBERS_WINE_LIST = `
WINE LIST

RED
Acrobat, Pinot Noir, Russian River Valley, CA 2023179
Justin, Cabernet Sauvignon, Adelaida District, CA 2020100
Caymus, Cabernet Sauvignon, Napa Valley, USA 2020 165
`;

const GEO_AND_BEVERAGE_NOISE = `
WINE LIST

RED
Acrobat, Pinot Noir, Russian River Valley, CA 2023 179
Coast, CA
Coast, CA
Coast, CA
Cooper Mountain, Valley, OR
Valley, OR

WHITE
Domaine Leflaive, Chassagne-Montrachet, Burgundy, France 2019 285
Château de Beaucastel, Châteauneuf-du-Pape, Southern Rhône, France 2018 220
Chassagne-Montrachet
Châteauneuf-du-Pape, Southern Rhône

BEER
Coors Light light lager 7
Corona Extra mexican lager 8
Stella Artois pilsner 9
Guinness stout 10
White Claw hard seltzer 8
Angry Orchard hard cider 8

COCKTAILS
Aperol Spritz 14
Classic Margarita 15
Espresso Martini 16
Old Fashioned 17
`;

function runSample(label: string, source: string) {
  const parsed = parseWineText(source, `${label}.txt`);
  const wines = filterFoodNoise(toWineEntries(parsed));
  console.log(`\n=== ${label} ===`);
  for (const sec of parsed.sections) {
    console.log(`[${sec.category}] ${sec.section} (${sec.items.length} items)`);
    for (const it of sec.items) {
      console.log(
        `  - ${it.producer ?? ''} | ${it.name} | vintage=${it.vintage} | varietal=${it.varietal ?? ''} | region=${it.region ?? ''} | country=${it.country ?? ''} | g=${it.glassPrice ?? '-'} b=${it.bottlePrice ?? '-'} p=${it.price ?? '-'} | bin=${it.binNumber ?? '-'}`
      );
    }
  }
  console.log(`Total wines after filterFoodNoise: ${wines.length}`);
  return { parsed, wines };
}

function main() {
  const { parsed, wines } = runSample('SAMPLE_WINE_LIST', SAMPLE_WINE_LIST);
  const { parsed: noisyParsed, wines: noisyWines } = runSample(
    'NOISY_WINE_LIST',
    NOISY_WINE_LIST
  );
  const { parsed: gluedParsed, wines: gluedWines } = runSample(
    'GLUED_NUMBERS_WINE_LIST',
    GLUED_NUMBERS_WINE_LIST
  );
  const { parsed: geoParsed, wines: geoWines } = runSample(
    'GEO_AND_BEVERAGE_NOISE',
    GEO_AND_BEVERAGE_NOISE
  );

  console.log('\n=== Sample entries (first 3) ===');
  for (const w of wines.slice(0, 3)) {
    console.log(JSON.stringify(w, null, 2));
  }
  console.log('\n=== Glued-number entries ===');
  for (const w of gluedWines) {
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
    [
      'NV handled',
      wines.some(
        (w) =>
          w.vintage === null &&
          /yquem|clicquot|taylor|dassai/i.test(`${w.producer ?? ''} ${w.name}`)
      )
    ],
    ['Varietal detected (cabernet sauvignon)', wines.some((w) => w.varietal === 'cabernet sauvignon')],
    ['Varietal detected (sauvignon blanc)', wines.some((w) => w.varietal === 'sauvignon blanc')],
    ['Region detected (napa valley)', wines.some((w) => /napa/i.test(w.region ?? ''))],
    ['Country detected (Argentina)', wines.some((w) => w.country === 'Argentina')],
    ['Glass+bottle prices captured', wines.some((w) => w.glassPrice && w.bottlePrice)],
    ['Food line excluded (Caesar Salad)', !wines.some((w) => /caesar/i.test(w.name))],
    ['Food line excluded (Lobster Roll)', !wines.some((w) => /lobster roll/i.test(w.name))],

    // Noisy list assertions
    [
      'NOISY: standalone "201795" is NOT a wine entry',
      !noisyWines.some((w) => /201795/.test(w.name))
    ],
    [
      'NOISY: standalone "201974" is NOT a wine entry',
      !noisyWines.some((w) => /201974/.test(w.name))
    ],
    [
      'NOISY: standalone "202082" is NOT a wine entry',
      !noisyWines.some((w) => /202082/.test(w.name))
    ],
    [
      'NOISY: standalone "123456" is NOT a wine entry',
      !noisyWines.some((w) => /123456/.test(w.name))
    ],
    [
      'NOISY: "Bin #4502" is NOT a wine entry',
      !noisyWines.some((w) => /bin/i.test(`${w.name} ${w.producer ?? ''}`))
    ],
    [
      'NOISY: "Page 12" is NOT a wine entry',
      !noisyWines.some((w) => /page 12/i.test(w.name))
    ],
    [
      'NOISY: bare "CA" line is NOT a wine entry',
      !noisyWines.some((w) => /^ca$/i.test(w.name.trim()))
    ],
    [
      'NOISY: bare "USA" line is NOT a wine entry',
      !noisyWines.some((w) => /^usa$/i.test(w.name.trim()))
    ],
    [
      'NOISY: real wine "Acrobat / Pinot Noir / Russian River" preserved',
      noisyWines.some(
        (w) =>
          /pinot noir/i.test(`${w.varietal ?? ''} ${w.name}`) &&
          /russian river/i.test(w.region ?? '')
      )
    ],
    [
      'NOISY: real wine "Sea Smoke / Pinot Noir" preserved',
      noisyWines.some((w) => /sea smoke/i.test(`${w.producer ?? ''} ${w.name}`))
    ],
    [
      'NOISY: real wine "Far Niente / Chardonnay" preserved',
      noisyWines.some(
        (w) =>
          /far niente/i.test(`${w.producer ?? ''} ${w.name}`) &&
          /chardonnay/i.test(w.varietal ?? '')
      )
    ],
    [
      'NOISY: total wine count is reasonable (< 10)',
      noisyWines.length > 0 && noisyWines.length <= 8
    ],

    // Glued vintage+bin assertions
    [
      'GLUED: "2023179" splits to vintage 2023 + bin 179 on Acrobat row',
      gluedWines.some(
        (w) =>
          /acrobat/i.test(`${w.producer ?? ''} ${w.name}`) &&
          w.vintage === 2023 &&
          w.binNumber === '179'
      )
    ],
    [
      'GLUED: "2020100" splits to vintage 2020 + bin 100 on Justin row',
      gluedWines.some(
        (w) =>
          /justin/i.test(`${w.producer ?? ''} ${w.name}`) &&
          w.vintage === 2020 &&
          w.binNumber === '100'
      )
    ],
    [
      'GLUED: Caymus row keeps vintage 2020 and price 165 untouched',
      gluedWines.some(
        (w) =>
          /caymus/i.test(`${w.producer ?? ''} ${w.name}`) &&
          w.vintage === 2020 &&
          (w.price === 165 || w.bottlePrice === 165)
      )
    ],
    [
      'GLUED: no entry has all-digit name',
      gluedWines.every((w) => !/^\d+$/.test(w.name.replace(/\s+/g, '')))
    ],

    // Geo-only fragment + beverage filtering assertions
    [
      'GEO: "Coast, CA" rejected (geo-only fragment)',
      !geoWines.some((w) => /^coast$/i.test(`${w.producer ?? ''} ${w.name}`.trim().replace(/,?\s*ca$/i, '').trim()))
        && !geoWines.some((w) => /coast/i.test(w.name) && (w.country === 'USA' || /CA/i.test(w.region ?? '')) && !w.producer && !w.vintage && !w.price && !w.varietal)
    ],
    [
      'GEO: no entry has bare "Coast" as name',
      !geoWines.some((w) => /^coast$/i.test(w.name.trim()))
    ],
    [
      'GEO: no entry has bare "Valley" as name',
      !geoWines.some((w) => /^valley$/i.test(w.name.trim()))
    ],
    [
      'GEO: "Cooper Mountain, Valley, OR" rejected (geo-only multi-fragment)',
      !geoWines.some((w) => /cooper mountain/i.test(`${w.producer ?? ''} ${w.name}`))
    ],
    [
      'GEO: duplicate "Coast, CA" entries de-duplicated',
      geoWines.filter((w) => /coast/i.test(w.name) && !w.varietal && !w.producer).length <= 1
    ],
    [
      'GEO: real wine "Acrobat / Pinot Noir / Russian River Valley" preserved',
      geoWines.some(
        (w) =>
          /acrobat/i.test(`${w.producer ?? ''} ${w.name}`) &&
          /pinot noir/i.test(w.varietal ?? '')
      )
    ],
    [
      'GEO: real wine "Chassagne-Montrachet / Domaine Leflaive" preserved',
      geoWines.some((w) => /leflaive/i.test(`${w.producer ?? ''} ${w.name}`))
    ],
    [
      'GEO: real wine "Châteauneuf-du-Pape, Southern Rhône" preserved (with producer)',
      geoWines.some((w) => /beaucastel/i.test(`${w.producer ?? ''} ${w.name}`))
    ],
    [
      'BEER: "Coors Light light lager" rejected',
      !geoWines.some((w) => /coors/i.test(`${w.producer ?? ''} ${w.name}`))
    ],
    [
      'BEER: "Corona Extra mexican lager" rejected',
      !geoWines.some((w) => /corona/i.test(`${w.producer ?? ''} ${w.name}`))
    ],
    [
      'BEER: "Stella Artois pilsner" rejected',
      !geoWines.some((w) => /stella/i.test(`${w.producer ?? ''} ${w.name}`))
    ],
    [
      'BEER: "Guinness stout" rejected',
      !geoWines.some((w) => /guinness/i.test(`${w.producer ?? ''} ${w.name}`))
    ],
    [
      'HARD SELTZER: "White Claw hard seltzer" rejected',
      !geoWines.some((w) => /white claw/i.test(`${w.producer ?? ''} ${w.name}`))
    ],
    [
      'CIDER: "Angry Orchard hard cider" rejected',
      !geoWines.some((w) => /angry orchard/i.test(`${w.producer ?? ''} ${w.name}`))
    ],
    [
      'COCKTAIL: "Aperol Spritz" rejected',
      !geoWines.some((w) => /aperol spritz/i.test(`${w.producer ?? ''} ${w.name}`))
    ],
    [
      'COCKTAIL: "Classic Margarita" rejected',
      !geoWines.some((w) => /margarita/i.test(`${w.producer ?? ''} ${w.name}`))
    ],
    [
      'COCKTAIL: "Espresso Martini" rejected',
      !geoWines.some((w) => /martini/i.test(`${w.producer ?? ''} ${w.name}`))
    ],
    [
      'COCKTAIL: "Old Fashioned" rejected',
      !geoWines.some((w) => /old fashioned/i.test(`${w.producer ?? ''} ${w.name}`))
    ],
    [
      'GEO+BEVERAGE: total wine count <= 5 (only real wines kept)',
      geoWines.length > 0 && geoWines.length <= 5
    ]
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
