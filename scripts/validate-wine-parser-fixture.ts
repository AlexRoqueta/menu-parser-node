import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseWineText, toWineEntries, filterFoodNoise } from '../src/wineParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(
  __dirname,
  'fixtures',
  'watergrill-wine-menu.txt'
);

function main() {
  const text = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const parsed = parseWineText(text, 'watergrill-wine-menu.txt');
  const wines = filterFoodNoise(toWineEntries(parsed));

  const blob = (w: { producer?: string; name: string }) =>
    `${w.producer ?? ''} ${w.name}`.trim();
  const has = (re: RegExp) => wines.some((w) => re.test(blob(w)));
  const absent = (token: string) =>
    !wines.some((w) => blob(w).includes(token));

  console.log('=== Water Grill fixture summary ===');
  console.log(`source: ${FIXTURE_PATH}`);
  console.log(`sections: ${parsed.sections.length}`);
  for (const s of parsed.sections) {
    console.log(`  [${s.category}] ${s.section} — ${s.items.length} items`);
  }
  console.log(`wines total (post filterFoodNoise): ${wines.length}`);
  console.log('\n=== First 40 wines ===');
  wines.slice(0, 40).forEach((w, i) => {
    const price =
      w.price ?? w.bottlePrice ?? w.glassPrice ?? null;
    const tail = [
      w.vintage ? `v${w.vintage}` : 'NV',
      price !== null ? `$${price}` : '',
      w.binNumber ? `bin#${w.binNumber}` : ''
    ]
      .filter(Boolean)
      .join(' ');
    console.log(`  [${i + 1}] ${blob(w)}  —  ${tail}`);
  });

  const noiseTokens = [
    'FREE SPIRITED',
    'THE PESSIMIST',
    'BRISTOL STREET',
    'ROSEWOOD',
    'THE AWAKENING',
    'STANDING ROOM',
    'MESCALERO',
    'A NIGHT IN OSAKA',
    'THE VISIONARY',
    "BARREL'LY' AGED",
    'JUBILEE',
    'Victory Golden Monkey',
    'Stella Liberte',
    'Sierra Nevada',
    'Corona Extra',
    'Sapporo',
    'Heineken',
    'Stella Artois',
    'Guinness',
    'Coors Light',
    'Pacifico',
    'Allagash',
    'Firestone Walker',
    'Ballast Point',
    'Golden Road',
    'Beachwood',
    'Stone Delicious',
    'Glenlivet',
    'Macallan',
    'Laphroaig',
    'Johnnie Walker',
    'Hennessy',
    'Suntory',
    'Hibiki',
    'Nikka',
    'Patrón',
    'Casamigos',
    'Don Julio',
    'Bacardi',
    'Captain Morgan',
    "Gosling's",
    'Beefeater',
    'Tanqueray',
    'Hendrick',
    "Tito's",
    'Ketel One',
    'Grey Goose',
    'Belvedere',
    'Stolichnaya'
  ];

  const fragmentTokens = [
    'Treviso, NV13.5',
    'CA NV19',
    'Cooper Mountain, Valley, OR',
    'Côtes de, 15.53 0',
    '2000Saracco',
    '228Lucien Albrecht'
  ];

  const bareNameFragments = [
    /^valley,? or$/i,
    /^épernay$/i,
    /^california$/i
  ];

  const bareGeo = [
    /^coast,? ca$/i,
    /^valley,? or$/i,
    /^valley,? ca$/i,
    /^cooper mountain,? valley,? or$/i,
    /^épernay$/i,
    /^california$/i
  ];

  const assertions: Array<[string, boolean]> = [
    // Preservation — at least one real wine present.
    ['preserve: Saracco Moscato d\'Asti present', has(/saracco moscato/i)],
    ['preserve: Hugel Riesling present', has(/hugel/i)],
    [
      'preserve: Domaine Villaudiere (Sancerre) present',
      has(/villaudiere/i)
    ],
    [
      "preserve: JM Brocard 'Sainte Claire' present",
      has(/jm brocard|sainte claire/i)
    ],
    ['preserve: Rombauer (Carneros) present', has(/rombauer/i)],
    ['preserve: Duckhorn Vineyards present', has(/duckhorn vineyards/i)],
    [
      "preserve: Lucien Albrecht 'Cuvée Balthazar' Pinot Blanc present",
      has(/lucien albrecht/i)
    ],
    // Sanity — count
    [
      `count: wine count is reasonable (got ${wines.length}, expected 120–230)`,
      wines.length >= 120 && wines.length <= 230
    ],
    // Cocktail / spirit-free noise absent
    ...noiseTokens.map(
      (n) =>
        [`noise absent: ${n}`, absent(n)] as [string, boolean]
    ),
    // OCR-glued fragment artifacts absent
    ...fragmentTokens.map(
      (n) =>
        [`fragment absent: ${n}`, absent(n)] as [string, boolean]
    ),
    // Pure region-only names absent
    ...bareGeo.map(
      (re) =>
        [
          `bare-geo absent: ${re}`,
          !wines.some((w) =>
            re.test(w.name.trim()) ||
            re.test(`${w.producer ?? ''} ${w.name}`.trim())
          )
        ] as [string, boolean]
    ),
    ...bareNameFragments.map(
      (re) =>
        [
          `bare name fragment absent: ${re}`,
          !wines.some((w) => re.test(w.name.trim()))
        ] as [string, boolean]
    ),
    // No `::` ornaments leaked
    [
      'no `::` ornament in any name or producer',
      wines.every((w) => !/::/.test(w.name) && !/::/.test(w.producer ?? ''))
    ],
    // No section-heading-only names
    [
      'no entry name equals "SPIRIT FREE" / "COCKTAILS" / "DRAUGHTS" / "SPIRITS"',
      wines.every(
        (w) =>
          !/^(?:spirit\s*free|cocktails?|draughts?|spirits?|bartender'?s\s+special|cans?\s+(?:and|&)\s+bottles?)$/i.test(
            w.name.trim()
          )
      )
    ]
  ];

  console.log('\n=== Fixture assertions ===');
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
