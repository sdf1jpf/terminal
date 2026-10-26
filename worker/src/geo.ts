// Where places are, for planning the company truck's routes (fleet.ts).
// There is no map service: the cities the truck serves are listed here,
// and a city not listed is put near the middle of its state, a short way
// off in a direction worked out from its name so two such cities differ.
// Road miles are the great-circle distance times ROAD_FACTOR.

export interface Point {
	lat: number;
	lon: number;
}

// The warehouse, which the truck leaves from and returns to.
export const DEPOT: Point & { name: string } = { name: "COLUMBUS, OH", lat: 39.96, lon: -83.0 };

export const ROAD_FACTOR = 1.2;

const cities: Record<string, Record<string, [number, number]>> = {
	OH: {
		COLUMBUS: [39.96, -83.0], DAYTON: [39.76, -84.19], CINCINNATI: [39.1, -84.51], CLEVELAND: [41.5, -81.69],
		TOLEDO: [41.66, -83.56], AKRON: [41.08, -81.52], YOUNGSTOWN: [41.1, -80.65], CANTON: [40.8, -81.38],
		SPRINGFIELD: [39.92, -83.81], LIMA: [40.74, -84.11], ZANESVILLE: [39.94, -82.01], MANSFIELD: [40.76, -82.52],
		ATHENS: [39.33, -82.1], MARION: [40.59, -83.13], CHILLICOTHE: [39.33, -82.98], SANDUSKY: [41.45, -82.71],
	},
	IN: {
		INDIANAPOLIS: [39.77, -86.16], "FORT WAYNE": [41.08, -85.14], GARY: [41.59, -87.35], "SOUTH BEND": [41.68, -86.25],
		EVANSVILLE: [37.97, -87.57], MUNCIE: [40.19, -85.39], RICHMOND: [39.83, -84.89], BLOOMINGTON: [39.17, -86.53],
		LAFAYETTE: [40.42, -86.88], "TERRE HAUTE": [39.47, -87.41],
	},
	KY: {
		LOUISVILLE: [38.25, -85.76], LEXINGTON: [38.04, -84.5], "BOWLING GREEN": [36.99, -86.44], COVINGTON: [39.08, -84.51],
		ASHLAND: [38.48, -82.64], FRANKFORT: [38.2, -84.87], OWENSBORO: [37.77, -87.11], PADUCAH: [37.08, -88.6],
	},
	MI: {
		DETROIT: [42.33, -83.05], "GRAND RAPIDS": [42.96, -85.67], LANSING: [42.73, -84.56], FLINT: [43.01, -83.69],
		"ANN ARBOR": [42.28, -83.74], KALAMAZOO: [42.29, -85.59], SAGINAW: [43.42, -83.95], "TRAVERSE CITY": [44.76, -85.62],
	},
	PA: {
		PITTSBURGH: [40.44, -79.99], PHILADELPHIA: [39.95, -75.17], HARRISBURG: [40.27, -76.88], ERIE: [42.13, -80.09],
		ALLENTOWN: [40.6, -75.47], BETHLEHEM: [40.63, -75.37], NORRISTOWN: [40.12, -75.34], SCRANTON: [41.41, -75.66],
		LANCASTER: [40.04, -76.31], READING: [40.34, -75.93], ALTOONA: [40.52, -78.39], "STATE COLLEGE": [40.79, -77.86],
		YORK: [39.96, -76.73],
	},
	WV: {
		CHARLESTON: [38.35, -81.63], HUNTINGTON: [38.42, -82.45], MORGANTOWN: [39.63, -79.96], WHEELING: [40.06, -80.72],
		PARKERSBURG: [39.27, -81.56], BECKLEY: [37.78, -81.19], CLARKSBURG: [39.28, -80.34], MARTINSBURG: [39.46, -77.96],
	},
};

const centers: Record<string, [number, number]> = {
	OH: [40.29, -82.79], IN: [39.89, -86.28], KY: [37.53, -85.3], MI: [43.33, -84.54], PA: [40.88, -77.8], WV: [38.6, -80.62],
};

function hash(s: string): number {
	let h = 2166136261;
	for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
	return h;
}

// locate returns where a city is: from the list, or near the middle of its
// state (or the warehouse, for a state the truck does not serve).
export function locate(city: string, state: string): Point {
	const c = city.trim().toUpperCase();
	const st = state.trim().toUpperCase();
	const known = cities[st]?.[c];
	if (known) return { lat: known[0], lon: known[1] };
	const [lat, lon] = centers[st] ?? [DEPOT.lat, DEPOT.lon];
	const h = hash(`${c},${st}`);
	return { lat: lat + ((h % 81) - 40) / 100, lon: lon + (((h >>> 8) % 121) - 60) / 100 };
}

const rad = (d: number) => (d * Math.PI) / 180;

// miles is the road distance between two points, in whole miles.
export function miles(a: Point, b: Point): number {
	const dlat = rad(b.lat - a.lat);
	const dlon = rad(b.lon - a.lon);
	const h = Math.sin(dlat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dlon / 2) ** 2;
	return Math.round(3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h))) * ROAD_FACTOR);
}

// bearing is the compass direction from a to b, in degrees from north.
export function bearing(a: Point, b: Point): number {
	const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
	const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
	return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// compass names a bearing: N, NE, E and so on.
export function compass(deg: number): string {
	return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
}
