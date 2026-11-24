// The demo sites Field Reports seeds its own server with (server/app/seed.py),
// so the tab can be tried before you have typed in a real one. Loaded only
// when you ask for it, and written to your own rows like anything else.

// name, address, region, asset tag, status, priority, access, contact, phone, days since last report
const SITES = [
  ['Dundas West Substation', '1180 Dundas St W, Toronto', 'Toronto Core', 'PLC-1041', 'needs_work', 1, 'Gate code 4417. Park in the laneway, not the bay.', 'Ravi Deshpande', '+1-416-555-0141', 2],
  ['Lakeshore Pump House', '22 Marine Pde Dr, Toronto', 'Toronto West', 'PMP-1042', 'ok', 3, 'Key from the harbour office desk before 16:00.', 'Nina Osei', '+1-416-555-0192', 9],
  ['Leslieville Transfer Point', '901 Eastern Ave, Toronto', 'Toronto East', 'XFR-1043', 'blocked', 1, 'Second access door is welded shut — use the north ramp.', 'Dale Whitfield', '+1-416-555-0127', 1],
  ['Mimico Relay Cabinet', '2340 Lake Shore Blvd W, Toronto', 'Toronto West', 'RLY-1044', 'ok', 2, 'Cabinet sits behind the hedge. Mind the wasp nest in summer.', 'Sofia Marchetti', '+1-416-555-0168', 21],
  ['Scarborough Bluffs Sensor Array', '1 Brimley Rd S, Toronto', 'Toronto East', 'SNS-1045', 'unvisited', 2, 'Long walk from the lot. Bring the long ladder.', 'Omar Haddad', '+1-416-555-0115', null],
  ['Weston Road Booster', '1911 Weston Rd, Toronto', 'Toronto North', 'BST-1046', 'needs_work', 2, 'Shared yard with the courier depot. Sign in at the hut.', 'Priya Balakrishnan', '+1-416-555-0173', 5],
  ['Humber Bay Flow Meter', '2111 Lake Shore Blvd W, Toronto', 'Toronto West', 'FLW-1047', 'ok', 3, 'Pedestrian access only. Cart will not fit the bridge.', 'Tomasz Wrobel', '+1-416-555-0134', 14],
  ['Danforth Vault 12', '2390 Danforth Ave, Toronto', 'Toronto East', 'VLT-1048', 'ok', 3, 'Confined space permit required. Two-person job.', 'Grace Nakamura', '+1-416-555-0156', 30],
  ['Etobicoke Creek Weir', '100 Elmcrest Rd, Toronto', 'Toronto West', 'WER-1049', 'needs_work', 1, 'No cell signal in the culvert — log it and sync at the truck.', 'Fatima Zahra', '+1-416-555-0188', 3],
  ['North York Switchgear B', '5100 Yonge St, Toronto', 'Toronto North', 'SWG-1050', 'ok', 2, 'Loading dock closes at 18:00 sharp.', "Liam O'Connell", '+1-416-555-0109', 11],
  ['Port Lands Telemetry Hut', '440 Unwin Ave, Toronto', 'Toronto East', 'TLM-1051', 'blocked', 1, 'Road washed out after rain. Check conditions before driving in.', 'Mei-Ling Chow', '+1-416-555-0147', 1],
  ['Rexdale Compressor Pad', '2 Carrier Dr, Toronto', 'Toronto North', 'CMP-1052', 'unvisited', 3, 'Hearing protection mandatory past the fence line.', 'Andre Fortin', '+1-416-555-0161', null],
  ['Queensway Valve Chamber', '1255 The Queensway, Toronto', 'Toronto West', 'VLV-1053', 'ok', 2, 'Chamber lid is heavy. Use the hook, not your back.', 'Hannah Eriksen', '+1-416-555-0120', 17],
  ['Don Valley Intake', '550 Bayview Ave, Toronto', 'Toronto Core', 'INT-1054', 'needs_work', 1, 'Trail is icy Nov–Mar. Spikes are in the truck bin.', 'Kwame Mensah', '+1-416-555-0199', 4],
];

// asset tag, finding, note, author, days ago
const REPORTS = [
  ['PLC-1041', 'needs_work', 'Door seal perished, water tracking down the inner panel. Logged for parts.', 'R. Deshpande', 2],
  ['PLC-1041', 'ok', 'Routine check, humidity in range, filters clear.', 'A. Fortin', 26],
  ['XFR-1043', 'blocked', 'Cannot reach the panel — pallets stacked against the enclosure. Escalated to site owner.', 'D. Whitfield', 1],
  ['BST-1046', 'needs_work', 'Pressure reading drifts about 8% above spec under load. Needs a recalibration visit.', 'P. Balakrishnan', 5],
  ['WER-1049', 'needs_work', 'Debris screen 60% blocked after the storm. Cleared what I could by hand.', 'F. Zahra', 3],
  ['TLM-1051', 'blocked', 'Approach road impassable, turned back at the rail crossing.', 'M. Chow', 1],
  ['INT-1054', 'needs_work', 'Intake grating bent, likely ice damage. Photos filed with the work order.', 'K. Mensah', 4],
  ['PMP-1042', 'ok', 'All nominal. Replaced the logbook, old one was full.', 'N. Osei', 9],
  ['SWG-1050', 'ok', 'Thermal scan clean across all three phases.', "L. O'Connell", 11],
];

/** Rows for `field_sites` and `field_reports`, owned by `owner`. */
export function demoRows(owner, newId, now = Date.now()) {
  const daysAgo = (d) => new Date(now - (d * 24 + 3) * 3_600_000).toISOString();
  const idOf = new Map();
  const sites = SITES.map(([name, address, region, tag, status, priority, access, contact, phone, days]) => {
    const id = newId();
    idOf.set(tag, id);
    return {
      id, owner, name, address, region, asset_tag: tag, status, priority,
      access_notes: access, contact_name: contact, contact_phone: phone,
      last_report_at: days == null ? null : daysAgo(days),
    };
  });
  const reports = REPORTS.map(([tag, status, note, author, days]) => ({
    id: `seed-${newId().replace(/-/g, '')}`,
    owner, site_id: idOf.get(tag), status, note, author, recorded_at: daysAgo(days),
  }));
  return { sites, reports };
}
