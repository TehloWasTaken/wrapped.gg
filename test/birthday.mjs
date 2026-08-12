import { worldAge, parseWorldBorn, BIRTHDAY_WINDOW_DAYS } from '../src/lib/birthday.js';

let fails = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) fails++;
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond || !detail ? '' : '  ' + detail));
};
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const at = (s) => Date.UTC(...s.split('-').map((v, i) => (i === 1 ? +v - 1 : +v))) / 1000;
const on = (born, day) => worldAge(at(born), at(day));

console.log('\nage');
eq('day one is Day 1', on('2020-06-14', '2020-06-14').day_number, 1);
eq('a day later is Day 2', on('2020-06-14', '2020-06-15').day_number, 2);
eq('a year of days', on('2020-06-14', '2021-06-14').age_days, 365);
eq('years complete on the anniversary', on('2020-06-14', '2021-06-14').age_years, 1);
eq('and not the day before', on('2020-06-14', '2021-06-13').age_years, 0);
eq('four years across a leap', on('2020-06-14', '2024-06-14').age_years, 4);

console.log('\nthe window');
ok('the anniversary itself', on('2020-06-14', '2023-06-14').is_birthday);
eq('and says which one', on('2020-06-14', '2023-06-14').turning, 3);
ok(`the last day of the ${BIRTHDAY_WINDOW_DAYS}-day window`,
   on('2020-06-14', '2023-06-20').is_birthday);
ok('one day past it', !on('2020-06-14', '2023-06-21').is_birthday);
ok('the day before it', !on('2020-06-14', '2023-06-13').is_birthday);
eq('and counts down to it', on('2020-06-14', '2023-06-13').days_until, 1);
eq('the next one is named', on('2020-06-14', '2023-06-13').next_age, 3);

console.log('\na world under a year old');
const young = on('2024-03-01', '2024-09-01');
ok('has no birthday to have', !young.is_birthday);
eq('and no completed years', young.age_years, 0);
eq('but still counts its days', young.day_number, 185);
eq('and knows when its first is', young.next_age, 1);

console.log('\n29 February');
const leapBorn = '2020-02-29';
ok('celebrates on the 28th in a common year', on(leapBorn, '2021-02-28').is_birthday);
eq('and calls it turning 1', on(leapBorn, '2021-02-28').turning, 1);
ok('not on 1 March', !on(leapBorn, '2021-03-01').is_birthday || on(leapBorn, '2021-03-01').turning === 1);
ok('celebrates on the 29th when there is one', on(leapBorn, '2024-02-29').is_birthday);
eq('and calls that turning 4', on(leapBorn, '2024-02-29').turning, 4);

console.log('\nrefusals');
eq('no date at all', worldAge(null), null);
eq('zero', worldAge(0), null);
eq('a date in the future', worldAge(at('2030-01-01'), at('2026-01-01')), null);

console.log('\nparsing');
eq('an ordinary date', parseWorldBorn('2019-06-14'), at('2019-06-14'));
eq('null clears it', parseWorldBorn(null), null);
eq('empty clears it', parseWorldBorn(''), null);
eq('31 February is refused', parseWorldBorn('2019-02-31'), undefined);
eq('a month of 13 is refused', parseWorldBorn('2019-13-01'), undefined);
eq('a year before Minecraft is refused', parseWorldBorn('1999-01-01'), undefined);
eq('the future is refused', parseWorldBorn('2099-01-01'), undefined);
eq('free text is refused', parseWorldBorn('last tuesday'), undefined);
eq('a timestamp is snapped to its day',
   parseWorldBorn(at('2019-06-14') + 3600), at('2019-06-14'));

console.log('\n' + (fails ? `FAILED (${fails})` : 'birthday arithmetic ok'));
process.exit(fails ? 1 : 0);
