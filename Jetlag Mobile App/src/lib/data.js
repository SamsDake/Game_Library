// data.js — question categories + full hider deck

export const CATEGORIES = [
  {
    id: 'matching', name: 'Matching', glyph: 'matching',
    blurb: 'Is your nearest ___ the same as mine?',
    make: (o) => `Is your nearest ${o} the same as my nearest ${o}?`,
    options: [
      'Commercial Airport','Transit Line','Street / Path','1st Administrative Division',
      '2nd Administrative Division','Mountain (1 km elevation)','Park','Amusement / Theme Park',
      'Zoo','Aquarium','Golf Course','Museum','Movie Theatre','Hospital','Library','Foreign Consulate',
    ],
    draw: 3, keep: 1, timerSec: 300, answer: { kind: 'choice', options: ['Yes', 'No'] }, gps: 'single',
  },
  {
    id: 'measuring', name: 'Measuring', glyph: 'measuring',
    blurb: 'Closer to or further from a ___?',
    make: (o) => `Compared to me, are you closer to or further from a ${o}?`,
    options: [
      'Commercial Airport','Transit Line','Street / Path','International Border','Sea Level','Coastline',
      'Mountain (1 km elevation)','Park','Amusement / Theme Park','Zoo','Aquarium','Golf Course',
      'Museum','Movie Theatre','Hospital','Library','Foreign Consulate',
    ],
    draw: 3, keep: 1, timerSec: 300, answer: { kind: 'choice', options: ['Closer', 'Further'] }, gps: 'single',
  },
  {
    id: 'thermometer', name: 'Thermometer', glyph: 'thermo',
    blurb: "I've traveled ___. Hotter or colder?",
    make: (o) => `I've just traveled ${o}. Am I hotter or colder?`,
    options: ['1 km', '5 km', '15 km', '75 km'],
    draw: 2, keep: 1, timerSec: 300, answer: { kind: 'choice', options: ['Hotter', 'Colder'] }, gps: 'double',
  },
  {
    id: 'radar', name: 'Radar', glyph: 'radar',
    blurb: 'Are you within ___ of me?',
    make: (o) => `Are you within ${o} of me?`,
    options: ['500 m','1 km','2 km','5 km','10 km','15 km','40 km','80 km','160 km','CUSTOM'],
    draw: 2, keep: 1, timerSec: 300, answer: { kind: 'choice', options: ['Yes', 'No'] }, gps: 'single',
  },
  {
    id: 'tentacles', name: 'Tentacles', glyph: 'tentacles',
    blurb: 'Which of these are you closest to?',
    make: (o) => `Of all the ${o.feature} within ${o.radius} of me, which are you closest to?`,
    options: [
      { feature: 'Museums', radius: '2 km' },{ feature: 'Libraries', radius: '2 km' },
      { feature: 'Movie Theatres', radius: '2 km' },{ feature: 'Hospitals', radius: '2 km' },
      { feature: 'Metro Lines', radius: '25 km' },{ feature: 'Zoos', radius: '25 km' },
      { feature: 'Aquariums', radius: '25 km' },{ feature: 'Amusement Parks', radius: '25 km' },
    ],
    optLabel: (o) => `${o.feature} · ${o.radius}`,
    draw: 4, keep: 2, timerSec: 300, answer: { kind: 'text', placeholder: "Name the one you're closest to" }, gps: 'none',
  },
  {
    id: 'photo', name: 'Photo', glyph: 'photo',
    blurb: 'Send a photo of…',
    make: (o) => `Send a photo: ${o.label}`,
    options: [
      { label: 'A tree', note: 'Must include the entire tree.' },
      { label: 'The sky', note: 'Place the phone on the ground, looking up.' },
      { label: 'Yourself', note: 'Hider selfie, arm fully extended.' },
      { label: 'Widest street', note: 'Must include both sides of the street.' },
      { label: 'Tallest structure in sightline', note: 'Tallest from your perspective; include the top and two sides, top in the upper third of frame.' },
      { label: 'Tallest building from the station', note: 'Stand directly outside the transit entrance. Include a roof and two sides, roof in the upper third.' },
      { label: 'Trace nearest street / path', note: 'Must be visible on a map.' },
      { label: 'Two buildings', note: 'Include the bottom and two stories of each.' },
      { label: 'Restaurant interior', note: 'No zoom — shoot it from the window.' },
      { label: 'Train platform', note: 'Include your platform edge and the opposite platform across the rail.' },
      { label: 'Park', note: 'Photograph it end to end.' },
      { label: 'Grocery store aisle', note: 'No zoom — shoot down the aisle.' },
      { label: 'Biggest body of water', note: 'Include opposite sides or the horizon.' },
      { label: '1 km Strava map', note: '5 turns, no doubling back; streets must be on maps.' },
    ],
    optLabel: (o) => o.label,
    draw: 1, keep: 1, timerSec: 1200, answer: { kind: 'photo' }, gps: 'none',
  },
];

export const CAT_BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

export function optionLabel(cat, opt) {
  if (opt == null) return '';
  if (cat.optLabel) return cat.optLabel(opt);
  return String(opt);
}

// ── The Hider Deck ───────────────────────────────────────────────
export const DECK = [
  // CURSES
  { id: 'egg_partner', type: 'curse', title: 'Curse of the Egg Partner', block: true, persist: true, notEndgame: true, costDiscard: { count: 2 },
    text: 'The seekers must acquire an egg before asking another question. This egg is now treated as an official team member of the seekers. If any team members are abandoned or killed (defined as any crack, in the egg\'s case) before the end of your run, you are awarded an extra 60 minutes. This curse cannot be played in the endgame.',
    cost: 'Discard two cards', bonusCondition: { min: 60, text: 'Was the egg abandoned or cracked?' } },
  { id: 'chalice', type: 'curse', title: 'Curse of the Overflowing Chalice', hiderEffect: 'drawBonus', drawBonus: 3, costDiscard: { count: 1 },
    text: 'For the next three questions, you may draw (not keep) an additional card when drawing from the hider deck.',
    cost: 'Discard a Card' },
  { id: 'drained_brain', type: 'curse', title: 'Curse of the Drained Brain', persist: true, costDiscard: { all: true },
    text: 'Choose three questions in different categories. The seekers cannot ask those questions for the rest of your run.',
    cost: 'Discard your hand' },
  { id: 'right_turn', type: 'curse', title: 'Curse of the Right Turn', duration: 60, costDiscard: { count: 1 },
    text: 'For the next 60 minutes, the seekers can only turn right at any street intersection. If at any point, they find themselves in a dead end where they cannot continue forward or turn right for another 300 metres, they may do a full 180. A right turn is defined as a road at any angle that veers to the right of the seekers.',
    cost: 'Discard a Card' },
  { id: 'lemon', type: 'curse', title: 'Curse of the Lemon Phylactery', block: true, persist: true, notEndgame: true, costDiscard: { type: 'powerup', count: 1 },
    text: 'Before asking another question, the seekers must each find a lemon and affix it to the outermost layer of their clothes or skin. If at any point, one of these lemons is no longer touching a seeker, you are awarded an extra 60 minutes. This curse cannot be played during the endgame.',
    cost: 'Discard a Powerup', bonusCondition: { min: 60, text: 'Did a lemon stop touching a seeker?' } },
  { id: 'u_turn', type: 'curse', title: 'Curse of the U-Turn', block: true,
    text: 'The seekers must disembark their current mode of transportation at the next station (as long as that station is serviced by another form of transit in the next hour.)',
    cost: 'Seekers must be heading in the wrong way. (Their next station is further away from you than they are)' },
  { id: 'hangman', type: 'curse', title: 'Curse of the Hidden Hangman', block: true, costDiscard: { count: 2 },
    text: 'Before asking another question or boarding another form of transportation, seekers must beat the hider in a game of hangman. To play, the hider chooses a 5 letter word, and the game ends after either a correct word guess or 7 wrong letter guesses. The hider must respond to all queries within 30 seconds. The seekers cannot challenge the hider for 10 minutes after a loss. After 3 losses, the seekers must wait 10 more minutes and then the curse is cleared.',
    cost: 'Discard 2 Cards' },
  { id: 'gamblers_feet', type: 'curse', title: "Curse of the Gambler's Feet", duration: 60,
    text: 'For the next 60 minutes, seekers must roll a die before they take any steps in any direction. They may take that many steps before rolling again.',
    cost: "Roll a die. If it's an even number, this curse has no effect" },
  { id: 'ransom_note', type: 'curse', title: 'Curse of the Ransom Note', block: true,
    text: 'The next question that the seekers ask must be composed of words and letters cut out of any printed material. The question must be coherent and include at least 5 words.',
    cost: 'Spell out "Ransom note" as a ransom note (without using this card)' },
  { id: 'spotty_memory', type: 'curse', title: 'Curse of the Spotty Memory', persist: true, costDiscard: { type: 'time', count: 1 },
    text: 'For the rest of your run, one random category of questions will be disabled at all times. After this curse is played, seekers must roll a die to determine the category of questions to be disabled. This category remains disabled until the next question is asked, at which point a die is rolled again to choose a new category. The same category can be disabled multiple times in a row.',
    cost: 'Discard a Time Bonus' },
  { id: 'distant_cuisine', type: 'curse', title: 'Curse of the Distant Cuisine', block: true,
    text: 'Find a restaurant within your zone that explicitly serves food from a specific foreign country. The seekers must visit a restaurant serving food from a country that is an equal or greater distance away before asking another question.',
    cost: 'You must be at the Restaurant' },
  { id: 'urban_explorer', type: 'curse', title: 'Curse of the Urban Explorer', persist: true, costDiscard: { count: 2 },
    text: 'For the rest of your run, seekers cannot ask questions when they are on transit or in a transit station.',
    cost: 'Discard 2 Cards' },
  { id: 'unguided_tourist', type: 'curse', title: 'Curse of the Unguided Tourist', block: true,
    text: 'Send the seekers an unzoomed Google Street View image from a street within 150 meters of where they are now. The shot has to be parallel to the horizon and include at least one human-built structure other than a road. Without using the internet for research, they must find what you sent them in real life before they can use transportation or ask another question. They must send a picture to the hider for verification.',
    cost: 'Seekers must be Outside' },
  { id: 'bridge_troll', type: 'curse', title: 'Curse of the Bridge Troll', block: true,
    text: 'The seekers must ask their next question from under a bridge.',
    cost: 'Seekers must be at least 50km away from you' },
  { id: 'bird_guide', type: 'curse', title: 'Curse of the Bird Guide', block: true,
    text: 'You have one chance to film a bird for as long as possible, up to 15 minutes straight. If, at any point, the bird leaves the frame, your timer is stopped. The seekers must then film a bird for the same amount of time or longer before asking another question.',
    cost: 'Film a bird' },
  { id: 'impressionable', type: 'curse', title: 'Curse of the Impressionable Consumer', block: true,
    text: 'Seekers must enter and gain admission (if applicable) to a location or buy a product that they saw an advertisement for before asking another question. This advertisement must be found out in the world, not on a seeker\'s device, and must be at least 30 meters from the product or location itself.',
    cost: 'The seeker\'s next question is free' },
  { id: 'water_weight', type: 'curse', title: 'Curse of the Water Weight', block: true, persist: true,
    text: 'The seekers must acquire and carry at least 2 litres of liquid per seeker for the rest of your run. They cannot ask another question until they have acquired the liquid. The water may be distributed between seekers as they see fit. If the liquid is lost or abandoned at any point after acquisition, the hider is awarded a 60 minute bonus.',
    cost: 'Seekers must be within 300 meters of a body of water.', bonusCondition: { min: 60, text: 'Was the water lost or abandoned?' } },
  { id: 'labyrinth', type: 'curse', title: 'Curse of the Labyrinth', block: true,
    text: 'Spend up to 30 minutes drawing a solvable maze and send a photo of it to the seekers. You cannot use the internet to research maze designs. The seekers must solve the maze before asking another question.',
    cost: 'Draw a maze.' },
  { id: 'luxury_car', type: 'curse', title: 'Curse of the Luxury Car', block: true,
    text: 'Take a photo of a car. The seekers must take a photo of a more expensive car before asking another question.',
    cost: 'A photo of a car' },
  { id: 'cairn', type: 'curse', title: 'Curse of the Cairn', block: true,
    text: 'You have one attempt to stack as many rocks on top of each other as you can in a freestanding tower. Each rock may only touch one other rock. Once you have added a rock to the tower, it may not be removed. Before adding another rock, the tower must stand for at least five seconds. If at any point, any rock other than the base rock touches the ground, your tower has fallen. Once your tower falls, tell the seekers how many rocks high your tower was when it last stood for five seconds. The seekers must then construct a rock tower of the same number of rocks, under the same parameters, before asking another question. If their tower falls, they must restart. The rocks must be found in nature, and both teams must disperse the rocks after building.',
    cost: 'Build a rock tower' },
  { id: 'jammed_door', type: 'curse', title: 'Curse of the Jammed Door', duration: 180, costDiscard: { count: 2 },
    text: 'For the next 3 hours whenever the seekers want to pass through a doorway into a building, business, train, or other vehicle, they must first roll 2 dice. If they do not roll a 7 or higher, they cannot enter that space (including through other doorways.) Any given door can be re-attempted after 15 minutes.',
    cost: 'Discard two cards.' },
  { id: 'endless_tumble', type: 'curse', title: 'Curse of the Endless Tumble', block: true,
    text: 'Seekers must roll a die at least 30 meters and have it land on a 5 or a 6 before they can ask another question. The die must roll the full distance, unaided, using only the momentum from the initial throw and gravity to travel the 30 meters. If the seekers accidentally hit someone with a die, you are awarded a 30 minute bonus.',
    cost: "Roll a die. If it's a 5 or a 6, this card has no effect.", bonusCondition: { min: 30, text: 'Did the die hit a person?' } },
  { id: 'travel_agent', type: 'curse', title: 'Curse of the Mediocre Travel Agent', block: true, persist: true,
    text: 'Choose any publicly-accessible place within 1 km of the seekers current location. They cannot currently be on transit. They must go there, and spend at least 10 minutes there, before asking another question. They must send you at least three photos of them enjoying their vacation, and procure an object to bring you as a souvenir. If this souvenir is lost before they can give it to you, you are awarded an extra 60 minutes.',
    cost: 'Their vacation destination must be further from you than their current location.', bonusCondition: { min: 60, text: 'Was the souvenir lost before handoff?' } },
  { id: 'zoologist', type: 'curse', title: 'Curse of the Zoologist', block: true,
    text: 'Take a photo of a wild fish, bird, mammal, reptile, amphibian, or bug. The seekers must take a picture of a wild animal in the same category before asking another question.',
    cost: 'A photo of an animal.' },

  // POWERUPS
  { id: 'move', type: 'powerup', power: 'move', notEndgame: true, title: 'Move', costDiscard: { all: true },
    text: 'Discard your hand and send the seekers the location of your transit station. This card grants a 60 minute period to establish a new hiding zone somewhere else on the game map. The seekers are frozen and your hiding timer is paused until this new hiding period has concluded. This card cannot be played during the endgame.',
    cost: 'Discard your hand' },
  { id: 'duplicate', type: 'powerup', power: 'duplicate', title: 'Duplicate Another Card',
    text: 'Play this card as a copy of any other card in your hand. This may be used to duplicate a time bonus at the end of your round.' },
  { id: 'discard12', type: 'powerup', power: 'discardDraw', discardN: 1, drawN: 2, title: 'Discard 1, Draw 2', costDiscard: { count: 1 },
    text: 'Discard one other card from your hand. Then, draw and keep two cards from the hider deck.' },
  { id: 'discard23', type: 'powerup', power: 'discardDraw', discardN: 2, drawN: 3, title: 'Discard 2, Draw 3', costDiscard: { count: 2 },
    text: 'Discard two other cards from your hand. Then, draw and keep three cards from the hider deck.' },
  { id: 'randomize', type: 'powerup', power: 'randomize', needsActiveQ: true, title: 'Randomize Question',
    text: 'Play instead of answering a question. A new unasked question from the same category is chosen, at random, which you answer instead.' },
  { id: 'veto', type: 'powerup', power: 'veto', needsActiveQ: true, title: 'Veto Question',
    text: 'Play instead of answering a question. No answer is given, and no reward is earned.' },

  // TIME BONUSES
  { id: 't15', type: 'time', bonusMin: 15, title: '15 Minute Time Bonus', text: 'Play this card to add 15 minutes to the total time of your run.' },
  { id: 't20', type: 'time', bonusMin: 20, title: '20 Minute Time Bonus', text: 'Play this card to add 20 minutes to the total time of your run.' },
  { id: 't30', type: 'time', bonusMin: 30, title: '30 Minute Time Bonus', text: 'Play this card to add 30 minutes to the total time of your run.' },
];

export const CARD_TYPES = {
  powerup: { label: 'Powerup', color: 'var(--c-powerup)' },
  curse:   { label: 'Curse',   color: 'var(--c-curse)' },
  time:    { label: 'Time Bonus', color: 'var(--c-time)' },
};
export const DECK_BY_ID = Object.fromEntries(DECK.map(c => [c.id, c]));
export const CURSE_POOL = DECK.filter(c => c.type === 'curse');
export const POWERUP_POOL = DECK.filter(c => c.type === 'powerup');
export const TIME_POOL = DECK.filter(c => c.type === 'time');

export const DEFAULT_DECK_CONFIG = {
  curses: 14,
  powerups: { move: 1, duplicate: 2, discard12: 2, discard23: 2, randomize: 2, veto: 2 },
  time: { t15: 3, t20: 2, t30: 1 },
};

export function buildDeck(cfg) {
  const c = cfg || DEFAULT_DECK_CONFIG;
  const pile = [];
  const curseN = Math.max(0, c.curses || 0);
  const shuffled = CURSE_POOL.map(x => x.id);
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  for (let i = 0; i < curseN; i++) pile.push(shuffled[i % shuffled.length]);
  Object.entries(c.powerups || {}).forEach(([id, n]) => { for (let i = 0; i < n; i++) pile.push(id); });
  Object.entries(c.time || {}).forEach(([id, n]) => { for (let i = 0; i < n; i++) pile.push(id); });
  for (let i = pile.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pile[i], pile[j]] = [pile[j], pile[i]]; }
  return pile;
}

export const SEED_LEADERBOARD = [
  { names: 'Mara & Theo', ms: 1000 * 60 * 184 },
  { names: 'The Gull Crew', ms: 1000 * 60 * 151 },
  { names: 'Quinn', ms: 1000 * 60 * 137 },
];

export const ADMIN_CODE = '6789';
export const MAX_HAND = 6;
export const MAP_GEO_CATS = ['radar', 'thermometer'];
