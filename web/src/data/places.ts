// Curated places: camera target (lon/lat), range (m), heading & pitch (degrees), and a short note.
export interface Place {
  id: string;
  name: string;
  kind: string;
  lon: number;
  lat: number;
  range: number;
  heading: number;
  pitch: number;
  hour?: number;          // suggested time of day for the tour
  text: string;
}

export const PLACES: Place[] = [
  {
    id: 'marina-bay', name: 'Marina Bay', kind: 'Waterfront', lon: 103.8572, lat: 1.2853, range: 1500, heading: 112, pitch: -16, hour: 18.9,
    text: 'The bay at the centre of the city is a freshwater reservoir, sealed from the sea by the Marina Barrage in 2008. Almost everything around it stands on land reclaimed since the 1970s.',
  },
  {
    id: 'gardens-by-the-bay', name: 'Gardens by the Bay', kind: 'Garden', lon: 103.8637, lat: 1.2816, range: 620, heading: 318, pitch: -20, hour: 19.9,
    text: 'A hundred hectares of reclaimed waterfront garden. The Supertree Grove’s vertical gardens rise 25 to 50 metres and light up nightly at 7:45 and 8:45 pm.',
  },
  {
    id: 'raffles-place', name: 'Raffles Place', kind: 'Financial district', lon: 103.8515, lat: 1.2839, range: 900, heading: 245, pitch: -24, hour: 17.6,
    text: 'The banking district on the south bank of the Singapore River. Its tallest towers stop near 280 metres, a ceiling set by aviation corridors.',
  },
  {
    id: 'singapore-river', name: 'Boat Quay & Clarke Quay', kind: 'Riverfront', lon: 103.8478, lat: 1.2879, range: 650, heading: 300, pitch: -22, hour: 19.4,
    text: 'Restored shophouses and godowns line the river that was the island’s working harbour for over a century, before cargo moved to the deep-water port.',
  },
  {
    id: 'chinatown', name: 'Chinatown', kind: 'Historic district', lon: 103.8441, lat: 1.2817, range: 520, heading: 35, pitch: -28, hour: 10.5,
    text: 'Rows of two- and three-storey shophouses with five-foot ways, around Pagoda Street, Smith Street and the Buddha Tooth Relic Temple.',
  },
  {
    id: 'pinnacle-duxton', name: 'The Pinnacle@Duxton', kind: 'Public housing', lon: 103.8414, lat: 1.2768, range: 520, heading: 20, pitch: -18, hour: 17.8,
    text: 'Seven 50-storey public housing towers joined by sky gardens on the 26th and 50th floors, completed in 2009 on the site of the first HDB flats in Tanjong Pagar.',
  },
  {
    id: 'tiong-bahru', name: 'Tiong Bahru', kind: 'Neighbourhood', lon: 103.8318, lat: 1.2847, range: 600, heading: 60, pitch: -30, hour: 9.2,
    text: 'One of Singapore’s oldest public housing estates, built in the 1930s with rounded Streamline Moderne walk-up blocks.',
  },
  {
    id: 'orchard-road', name: 'Orchard Road', kind: 'Shopping boulevard', lon: 103.8318, lat: 1.3039, range: 900, heading: 250, pitch: -22, hour: 20.2,
    text: 'A tree-lined boulevard of malls and hotels that grew over former nutmeg and pepper plantations.',
  },
  {
    id: 'little-india', name: 'Little India', kind: 'Historic district', lon: 103.8519, lat: 1.3066, range: 650, heading: 330, pitch: -26, hour: 18.6,
    text: 'Serangoon Road and its side streets: temples, spice shops and colourful shophouses that have anchored the Tamil community since the 19th century.',
  },
  {
    id: 'kampong-glam', name: 'Kampong Glam', kind: 'Historic district', lon: 103.8590, lat: 1.3025, range: 480, heading: 225, pitch: -26, hour: 17.9,
    text: 'The old Malay and Arab quarter around Sultan Mosque and Arab Street, with some of the island’s best-preserved shophouse streets.',
  },
  {
    id: 'esplanade', name: 'Esplanade', kind: 'Performing arts', lon: 103.8556, lat: 1.2899, range: 420, heading: 200, pitch: -24, hour: 19.0,
    text: 'Two glass shells clad in thousands of triangular aluminium sunshades. Locals call them “the durians”.',
  },
  {
    id: 'sports-hub', name: 'Singapore Sports Hub', kind: 'Stadium', lon: 103.8743, lat: 1.3044, range: 1100, heading: 230, pitch: -24, hour: 16.5,
    text: 'The National Stadium’s retractable roof spans 310 metres, one of the largest free-spanning domes in the world.',
  },
  {
    id: 'bukit-timah', name: 'Bukit Timah Hill', kind: 'Nature reserve', lon: 103.7764, lat: 1.3546, range: 1600, heading: 20, pitch: -18, hour: 7.6,
    text: 'The island’s highest point at 164 metres, crowned by primary rainforest that has never been cleared.',
  },
  {
    id: 'macritchie', name: 'MacRitchie Reservoir', kind: 'Reservoir', lon: 103.8250, lat: 1.3446, range: 2400, heading: 330, pitch: -20, hour: 7.2,
    text: 'Singapore’s oldest reservoir, completed in 1868, ringed by the Central Catchment’s secondary and primary forest.',
  },
  {
    id: 'henderson-waves', name: 'Henderson Waves', kind: 'Southern Ridges', lon: 103.8152, lat: 1.2763, range: 500, heading: 90, pitch: -12, hour: 18.6,
    text: 'A timber deck that undulates 36 metres above Henderson Road, linking Mount Faber and Telok Blangah Hill along the Southern Ridges.',
  },
  {
    id: 'sentosa', name: 'Sentosa', kind: 'Island', lon: 103.8300, lat: 1.2494, range: 3200, heading: 340, pitch: -22, hour: 17.8,
    text: 'A resort island facing the Singapore Strait, where hundreds of ships wait at anchor on one of the world’s busiest sea lanes.',
  },
  {
    id: 'keppel-bay', name: 'Keppel Bay', kind: 'Waterfront', lon: 103.8150, lat: 1.2652, range: 1200, heading: 160, pitch: -18, hour: 18.2,
    text: 'A marina between the mainland and Sentosa, framed by the curving towers of Reflections at Keppel Bay.',
  },
  {
    id: 'toa-payoh', name: 'Toa Payoh', kind: 'HDB town', lon: 103.8478, lat: 1.3343, range: 1100, heading: 20, pitch: -20, hour: 19.6,
    text: 'One of the first satellite towns built by the Housing & Development Board in the late 1960s. Most Singaporeans live in public housing like this.',
  },
  {
    id: 'punggol', name: 'Punggol', kind: 'HDB town', lon: 103.9030, lat: 1.4042, range: 2000, heading: 200, pitch: -20, hour: 18.3,
    text: 'A newer waterfront town in the northeast, laid out around a man-made waterway and served by its own light-rail loops.',
  },
  {
    id: 'jewel', name: 'Jewel Changi', kind: 'Airport', lon: 103.9894, lat: 1.3602, range: 900, heading: 300, pitch: -25, hour: 20.4,
    text: 'A toroidal glass dome at Changi Airport around the Rain Vortex, a 40-metre indoor waterfall.',
  },
  {
    id: 'changi', name: 'Changi Airport', kind: 'Airport', lon: 103.9915, lat: 1.3592, range: 6500, heading: 340, pitch: -28, hour: 21.0,
    text: 'Built on reclaimed land at the island’s eastern tip; its third runway is being extended into the sea.',
  },
  {
    id: 'east-coast', name: 'East Coast Park', kind: 'Park', lon: 103.9200, lat: 1.3010, range: 1800, heading: 60, pitch: -18, hour: 17.2,
    text: 'Fifteen kilometres of beach and parkland on reclaimed shore, facing anchored ships in the strait.',
  },
  {
    id: 'pulau-ubin', name: 'Pulau Ubin', kind: 'Island', lon: 103.9612, lat: 1.4092, range: 3800, heading: 250, pitch: -20, hour: 7.4,
    text: 'An island of granite quarries, mangroves and the last kampong houses, a ten-minute bumboat ride from Changi Point.',
  },
  {
    id: 'jurong-island', name: 'Jurong Island', kind: 'Industry', lon: 103.7040, lat: 1.2660, range: 6500, heading: 20, pitch: -24, hour: 20.5,
    text: 'Seven islands merged by reclamation into one of the world’s largest petrochemical hubs.',
  },
  {
    id: 'woodlands', name: 'The Causeway', kind: 'Border', lon: 103.7690, lat: 1.4530, range: 2600, heading: 10, pitch: -18, hour: 18.0,
    text: 'The 1.1-kilometre causeway across the Johor Strait to Johor Bahru, one of the busiest land crossings in the world.',
  },
];

export const INTRO_TARGET = { lon: 103.8590, lat: 1.2845, range: 2200, heading: 330, pitch: -15 };
