// Regenerates config/regions.json by merging Natural Earth 1:110m countries.
// Unmapped countries fail the run; small islands still resolve by nearest centroid.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { merge } from 'topojson-client';

const TOPO_PATH = fileURLToPath(new URL('../../../../admin-web/public/countries-110m.json', import.meta.url));
const OUT_PATH = fileURLToPath(new URL('../../../config/regions.json', import.meta.url));

const MIN_POLYGON_AREA_DEG2 = 0.5;
const COORD_DECIMALS = 2;

const REGIONS = [
  {
    slug: 'middle-east',
    name: 'Middle East',
    description: 'Turkey, the Levant, Iran, and the Arabian Peninsula.',
    priority: 10,
    color: '#d97706',
    centroidLat: 25.2,
    centroidLng: 55.3,
  },
  {
    slug: 'central-america',
    name: 'Central America & Caribbean',
    description: 'Mexico, Central America, and the Caribbean.',
    priority: 20,
    color: '#16a34a',
    centroidLat: 19.4,
    centroidLng: -99.1,
  },
  {
    slug: 'south-america',
    name: 'South America',
    description: 'The South American continent.',
    priority: 30,
    color: '#059669',
    centroidLat: -23.5,
    centroidLng: -46.6,
  },
  {
    slug: 'oceania',
    name: 'Oceania',
    description: 'Australia, New Zealand, and the Pacific islands.',
    priority: 35,
    color: '#0891b2',
    centroidLat: -33.9,
    centroidLng: 151.2,
  },
  {
    slug: 'europe',
    name: 'Europe',
    description: 'The European continent, including Russia.',
    priority: 40,
    color: '#2563eb',
    centroidLat: 50.1,
    centroidLng: 8.7,
    // Drop French Guiana from France's multipolygon.
    dropPolygonWhen: ({ lng }) => lng < -30,
  },
  {
    slug: 'africa',
    name: 'Africa',
    description: 'The African continent.',
    priority: 50,
    color: '#c58504',
    centroidLat: -26.2,
    centroidLng: 28.0,
  },
  {
    slug: 'asia',
    name: 'Asia',
    description: 'South, Southeast, East, and Central Asia.',
    priority: 60,
    color: '#dc2626',
    centroidLat: 1.35,
    centroidLng: 103.8,
  },
  {
    slug: 'north-america',
    name: 'North America',
    description: 'The United States, Canada, and Greenland.',
    priority: 90,
    color: '#7c3aed',
    centroidLat: 39.0,
    centroidLng: -77.5,
  },
];

// Natural Earth country → region; null entries are deliberate exclusions.
// Russia stays whole in Europe; nearest-centroid fallback handles Asian zones.
const COUNTRY_REGIONS = {
  // north-america
  'United States of America': 'north-america',
  Canada: 'north-america',
  Greenland: 'north-america',
  // central-america
  Mexico: 'central-america',
  Guatemala: 'central-america',
  Belize: 'central-america',
  Honduras: 'central-america',
  'El Salvador': 'central-america',
  Nicaragua: 'central-america',
  'Costa Rica': 'central-america',
  Panama: 'central-america',
  Cuba: 'central-america',
  Haiti: 'central-america',
  'Dominican Rep.': 'central-america',
  Jamaica: 'central-america',
  'Puerto Rico': 'central-america',
  'Trinidad and Tobago': 'central-america',
  Bahamas: 'central-america',
  // south-america
  Brazil: 'south-america',
  Argentina: 'south-america',
  Chile: 'south-america',
  Peru: 'south-america',
  Colombia: 'south-america',
  Venezuela: 'south-america',
  Ecuador: 'south-america',
  Bolivia: 'south-america',
  Paraguay: 'south-america',
  Uruguay: 'south-america',
  Guyana: 'south-america',
  Suriname: 'south-america',
  'Falkland Is.': 'south-america',
  // europe
  Iceland: 'europe',
  Norway: 'europe',
  Sweden: 'europe',
  Finland: 'europe',
  Denmark: 'europe',
  'United Kingdom': 'europe',
  Ireland: 'europe',
  France: 'europe',
  Spain: 'europe',
  Portugal: 'europe',
  Germany: 'europe',
  Netherlands: 'europe',
  Belgium: 'europe',
  Luxembourg: 'europe',
  Switzerland: 'europe',
  Austria: 'europe',
  Italy: 'europe',
  Poland: 'europe',
  Czechia: 'europe',
  Slovakia: 'europe',
  Hungary: 'europe',
  Romania: 'europe',
  Bulgaria: 'europe',
  Greece: 'europe',
  Albania: 'europe',
  'North Macedonia': 'europe',
  Macedonia: 'europe',
  Serbia: 'europe',
  Croatia: 'europe',
  'Bosnia and Herz.': 'europe',
  Slovenia: 'europe',
  Montenegro: 'europe',
  Kosovo: 'europe',
  Moldova: 'europe',
  Ukraine: 'europe',
  Belarus: 'europe',
  Lithuania: 'europe',
  Latvia: 'europe',
  Estonia: 'europe',
  Russia: 'europe',
  Cyprus: 'europe',
  'N. Cyprus': 'europe',
  // middle-east
  Turkey: 'middle-east',
  Syria: 'middle-east',
  Lebanon: 'middle-east',
  Israel: 'middle-east',
  Palestine: 'middle-east',
  Jordan: 'middle-east',
  Iraq: 'middle-east',
  Iran: 'middle-east',
  'Saudi Arabia': 'middle-east',
  Yemen: 'middle-east',
  Oman: 'middle-east',
  'United Arab Emirates': 'middle-east',
  Qatar: 'middle-east',
  Kuwait: 'middle-east',
  // africa
  Morocco: 'africa',
  'W. Sahara': 'africa',
  Algeria: 'africa',
  Tunisia: 'africa',
  Libya: 'africa',
  Egypt: 'africa',
  Sudan: 'africa',
  'S. Sudan': 'africa',
  Chad: 'africa',
  Niger: 'africa',
  Mali: 'africa',
  Mauritania: 'africa',
  Senegal: 'africa',
  Gambia: 'africa',
  'Guinea-Bissau': 'africa',
  Guinea: 'africa',
  'Sierra Leone': 'africa',
  Liberia: 'africa',
  "Côte d'Ivoire": 'africa',
  Ghana: 'africa',
  Togo: 'africa',
  Benin: 'africa',
  'Burkina Faso': 'africa',
  Nigeria: 'africa',
  Cameroon: 'africa',
  'Central African Rep.': 'africa',
  'Dem. Rep. Congo': 'africa',
  Congo: 'africa',
  Gabon: 'africa',
  'Eq. Guinea': 'africa',
  Uganda: 'africa',
  Kenya: 'africa',
  Tanzania: 'africa',
  Rwanda: 'africa',
  Burundi: 'africa',
  Ethiopia: 'africa',
  Eritrea: 'africa',
  Djibouti: 'africa',
  Somalia: 'africa',
  Somaliland: 'africa',
  Angola: 'africa',
  Zambia: 'africa',
  Malawi: 'africa',
  Mozambique: 'africa',
  Zimbabwe: 'africa',
  Botswana: 'africa',
  Namibia: 'africa',
  'South Africa': 'africa',
  Lesotho: 'africa',
  eSwatini: 'africa',
  Swaziland: 'africa',
  Madagascar: 'africa',
  // asia
  China: 'asia',
  Mongolia: 'asia',
  'North Korea': 'asia',
  'South Korea': 'asia',
  Japan: 'asia',
  India: 'asia',
  Pakistan: 'asia',
  Afghanistan: 'asia',
  Nepal: 'asia',
  Bhutan: 'asia',
  Bangladesh: 'asia',
  'Sri Lanka': 'asia',
  Myanmar: 'asia',
  Thailand: 'asia',
  Laos: 'asia',
  Vietnam: 'asia',
  Cambodia: 'asia',
  Malaysia: 'asia',
  Indonesia: 'asia',
  Philippines: 'asia',
  Brunei: 'asia',
  Taiwan: 'asia',
  Kazakhstan: 'asia',
  Uzbekistan: 'asia',
  Turkmenistan: 'asia',
  Kyrgyzstan: 'asia',
  Tajikistan: 'asia',
  Georgia: 'asia',
  Armenia: 'asia',
  Azerbaijan: 'asia',
  'Timor-Leste': 'asia',
  // oceania
  Australia: 'oceania',
  'New Zealand': 'oceania',
  'Papua New Guinea': 'oceania',
  Fiji: 'oceania',
  'Solomon Is.': 'oceania',
  Vanuatu: 'oceania',
  'New Caledonia': 'oceania',
  // deliberately unassigned (nearest-centroid fallback covers them)
  Antarctica: null,
  'Fr. S. Antarctic Lands': null,
};

function ringAreaDeg2(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(area / 2);
}

function ringCentroid(ring) {
  let lng = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lng += x;
    lat += y;
  }
  return { lng: lng / ring.length, lat: lat / ring.length };
}

function roundRing(ring) {
  const factor = 10 ** COORD_DECIMALS;
  const rounded = ring.map(([lng, lat]) => [Math.round(lng * factor) / factor, Math.round(lat * factor) / factor]);
  // Rounding can collapse neighbours into duplicates — drop them, keep closure.
  const out = rounded.filter((point, i) => i === 0 || point[0] !== rounded[i - 1][0] || point[1] !== rounded[i - 1][1]);
  const first = out[0];
  const last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  return out;
}

// Split antimeridian-crossing rings to keep planar lookup and globe strokes correct.
function unwrapRing(ring) {
  // Make longitudes continuous: consecutive deltas end up < 180°, so a
  // wrap-crossing ring extends past ±180 instead of jumping.
  const out = [[ring[0][0], ring[0][1]]];
  let offset = 0;
  for (let i = 1; i < ring.length; i++) {
    let lng = ring[i][0] + offset;
    const prev = out[i - 1][0];
    if (lng - prev > 180) {
      offset -= 360;
      lng -= 360;
    } else if (lng - prev < -180) {
      offset += 360;
      lng += 360;
    }
    out.push([lng, ring[i][1]]);
  }
  return out;
}

function clipRingAtLongitude(ring, keepBelow, boundary) {
  // Sutherland–Hodgman against the lng <= boundary (or >=) halfplane.
  const inside = ([lng]) => (keepBelow ? lng <= boundary : lng >= boundary);
  const out = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    if (inside(a)) out.push(a);
    if (inside(a) !== inside(b)) {
      const t = (boundary - a[0]) / (b[0] - a[0]);
      out.push([boundary, a[1] + (b[1] - a[1]) * t]);
    }
  }
  if (out.length < 3) return null;
  out.push([out[0][0], out[0][1]]);
  return out;
}

function splitPolygonAtAntimeridian(polygon) {
  const outer = polygon[0];
  const crossesWrap = outer.some((point, i) => i > 0 && Math.abs(point[0] - outer[i - 1][0]) > 180);
  if (!crossesWrap) return [polygon];
  if (polygon.length > 1) throw new Error('antimeridian split for polygons with holes is not implemented');
  const unwrapped = unwrapRing(outer);
  const boundary = Math.max(...unwrapped.map((point) => point[0])) > 180 ? 180 : -180;
  const main = clipRingAtLongitude(unwrapped, boundary === 180, boundary);
  const overflow = clipRingAtLongitude(unwrapped, boundary !== 180, boundary)?.map(([lng, lat]) => [
    lng - Math.sign(boundary) * 360,
    lat,
  ]);
  return [main, overflow].filter(Boolean).map((ring) => [ring]);
}

function assertNoWrapJumps(polygons) {
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 1; i < ring.length; i++) {
        if (Math.abs(ring[i][0] - ring[i - 1][0]) > 180) {
          throw new Error('a ring still jumps the antimeridian after splitting');
        }
      }
    }
  }
}

function cleanMultiPolygon(multi, dropPolygonWhen) {
  const polygons = [];
  for (const rawPolygon of multi.coordinates) {
    // Split before the area/centroid checks — a wrap-crossing ring's planar
    // shoelace area and centroid are meaningless.
    for (const polygon of splitPolygonAtAntimeridian(rawPolygon)) {
      const outer = polygon[0];
      if (!outer || ringAreaDeg2(outer) < MIN_POLYGON_AREA_DEG2) continue;
      if (dropPolygonWhen?.(ringCentroid(outer))) continue;
      const rings = polygon
        .map(roundRing)
        .filter((ring, i) => ring.length >= 4 && (i === 0 || ringAreaDeg2(ring) >= MIN_POLYGON_AREA_DEG2));
      if (rings.length > 0) polygons.push(rings);
    }
  }
  assertNoWrapJumps(polygons);
  return { type: 'MultiPolygon', coordinates: polygons };
}

const topo = JSON.parse(readFileSync(TOPO_PATH, 'utf8'));
const geometries = topo.objects.countries.geometries;

const unmapped = geometries.map((g) => g.properties.name).filter((name) => !(name in COUNTRY_REGIONS));
if (unmapped.length > 0) {
  console.error(`unmapped countries (add them to COUNTRY_REGIONS): ${unmapped.join(', ')}`);
  process.exit(1);
}

const bySlug = new Map(REGIONS.map((region) => [region.slug, []]));
for (const geometry of geometries) {
  const slug = COUNTRY_REGIONS[geometry.properties.name];
  if (slug) bySlug.get(slug).push(geometry);
}

const lines = REGIONS.map(({ dropPolygonWhen, ...meta }) => {
  const boundary = cleanMultiPolygon(merge(topo, bySlug.get(meta.slug)), dropPolygonWhen);
  const points = boundary.coordinates.flat(2).length;
  console.log(
    `${meta.slug}: ${bySlug.get(meta.slug).length} countries → ${boundary.coordinates.length} polygons, ${points} points`,
  );
  const metaJson = JSON.stringify(meta, null, 2).slice(1, -2); // inner fields, keep our own braces
  return `  {${metaJson},\n    "boundary": ${JSON.stringify(boundary)}\n  }`;
});

writeFileSync(OUT_PATH, `[\n${lines.join(',\n')}\n]\n`);
console.log(`wrote ${OUT_PATH}`);
