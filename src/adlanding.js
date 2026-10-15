// House cleaning ad landing: GET /house-cleaning/?loc=<Google location ID>
//
// WHY THIS EXISTS
// The residential Google Ads campaign targets four cities with one set of
// keywords ("house cleaning near me" says nothing about which city), so the
// keyword cannot pick the page. Google can, though: the campaign's Final URL
// suffix is "loc={loc_physical_ms}", which Google fills in with the location
// ID of where the person was when they clicked. The Final URL stays the
// general page (/services/house-cleaning/); src/index.js sends any request to
// it that carries loc here, and /house-cleaning/ is a short alias. This turns
// that ID into the matching city page, so a searcher in Gilbert lands on
// "House Cleaning in Gilbert, AZ" instead of the general page.
//
// The IDs are Google's own geotarget criteria IDs (developers.google.com/
// google-ads/api/data/geotargets, 2026-10-06 file). Google reports either the
// city itself or, often, the ZIP code, and ZIP criteria hang off the state,
// not the city - so each city's ZIP codes are listed by hand. Chandler
// (1013387) is deliberately absent: we do not serve it.
//
// Anything unrecognised - no loc, a city we do not list, Google's ad-review
// crawler, which fetches the bare Final URL - goes to the general house
// cleaning page. Every other query parameter is passed through untouched:
// gclid / wbraid / gbraid must reach the landing page or site.js cannot store
// the click, and the conversion feed would never credit the ad.

const PAGES = {
  mesa: "/locations/mesa/",
  gilbert: "/locations/gilbert/house-cleaning/",
  queenCreek: "/locations/queen-creek/house-cleaning/",
  sanTanValley: "/locations/san-tan-valley/house-cleaning/",
};

export const FALLBACK_PAGE = "/services/house-cleaning/";

export const LOCATION_PAGES = new Map([
  // Cities
  ["1013445", PAGES.mesa],
  ["1013416", PAGES.gilbert],
  ["1013469", PAGES.queenCreek],
  ["9052798", PAGES.sanTanValley],
  // Mesa ZIPs 85201-85210, 85212, 85213, 85215
  ["9030029", PAGES.mesa], ["9030030", PAGES.mesa], ["9030031", PAGES.mesa],
  ["9030032", PAGES.mesa], ["9030033", PAGES.mesa], ["9030034", PAGES.mesa],
  ["9030035", PAGES.mesa], ["9030036", PAGES.mesa], ["9030037", PAGES.mesa],
  ["9030038", PAGES.mesa], ["9030039", PAGES.mesa], ["9030040", PAGES.mesa],
  ["9030041", PAGES.mesa],
  // Gilbert ZIPs 85233, 85234, 85295-85298
  ["9030055", PAGES.gilbert], ["9030056", PAGES.gilbert], ["9030095", PAGES.gilbert],
  ["9030096", PAGES.gilbert], ["9030097", PAGES.gilbert], ["9030098", PAGES.gilbert],
  // Queen Creek ZIP 85142
  ["9030021", PAGES.queenCreek],
  // San Tan Valley ZIPs 85140, 85143
  ["9053836", PAGES.sanTanValley], ["9053835", PAGES.sanTanValley],
]);

// Where a click should land, as a path plus query string.
export function landingFor(url) {
  const params = new URLSearchParams(url.search);
  const loc = (params.get("loc") || "").trim();
  params.delete("loc");
  const path = LOCATION_PAGES.get(loc) || FALLBACK_PAGE;
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function handleAdLanding(request) {
  const url = new URL(request.url);
  return new Response(null, {
    status: 302,
    headers: {
      Location: landingFor(url),
      // Per-click answer: never cache it, never index the hop.
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
