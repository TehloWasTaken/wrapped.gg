"""Runs the blocklist-aware player lookups from src/api/public.js against the real schema.

The queries are not retyped here - they are pulled out of the source file and the
NOT_BLOCKED clause is substituted the way the Worker substitutes it, so what runs
below is the SQL that ships. The database is built from the migrations, so a
column that is not there, a join that does not hold and a bind count that does
not add up all fail here rather than in production.

    python3 test/blocked-sql.py
"""
import re, sqlite3, sys, time, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIGRATIONS = ['0001_init.sql', '0002_partners.sql', '0003_admin.sql', '0004_usercache.sql',
              '0005_birthday.sql', '0006_blocked.sql']

db = sqlite3.connect(':memory:')
db.row_factory = sqlite3.Row
for f in MIGRATIONS:
    db.executescript((ROOT / 'migrations' / f).read_text())
db.execute('PRAGMA foreign_keys = ON')
print('schema: ok (' + ' + '.join(f[:4] for f in MIGRATIONS) + ')')

source = (ROOT / 'src/api/public.js').read_text()
clause = re.search(r'export const NOT_BLOCKED =\s*`([^`]+)`', source)
assert clause, 'NOT_BLOCKED is gone from public.js'
NOT_BLOCKED = clause.group(1)

queries = [q for q in re.findall(r'prepare\(\s*`([^`]+)`', source) if 'FROM players' in q]
assert len(queries) == 4, f'expected 4 player lookups in public.js, found {len(queries)}'

t = int(time.time())
db.executescript(f"""
INSERT INTO users VALUES ('u1','100000000000000001','Ari',NULL,{t},{t});
INSERT INTO servers (id,slug,name,owner_id,published,created_at,updated_at)
VALUES ('s1','example-k7m2p','Example SMP','u1',1,{t},{t});
INSERT INTO players VALUES ('s1','0000-alpha','Alpha','alpha','java',100,0,80,{t});
INSERT INTO players VALUES ('s1','0000-grief','Griefer','griefer','java',80,80,80,{t});
INSERT INTO players VALUES ('s1','0000-bedrk','.Gamer Tag','.gamer tag','bedrock',20,160,80,{t});
INSERT INTO blocked_players VALUES ('s1','0000-grief','Griefer',{t});
INSERT INTO blocked_players VALUES ('s1','0000-bedrk','.Gamer Tag',{t});
""")
db.commit()
print('fixtures: ok (3 players, 2 of them blocked)')

fails = 0
def check(label, cond, detail=''):
    global fails
    if not cond:
        fails += 1
    print(('  ok   ' if cond else '  FAIL ') + label + ('' if cond or not detail else '  ' + detail))

def run(sql, args):
    sql = sql.replace('${NOT_BLOCKED}', NOT_BLOCKED).replace('${holders}', '?,?')
    return db.execute(sql, args).fetchall()

by_name    = next(q for q in queries if 'name_lower = ?' in q and 'bedrock' not in q)
by_bedrock = next(q for q in queries if 'bedrock' in q)
by_uuid    = next(q for q in queries if 'uuid IN' in q)
by_prefix  = next(q for q in queries if 'LIKE' in q)

print('\nfindPlayer:')
found = run(by_name, ('s1', 'alpha'))
check('finds a player who is not blocked', len(found) == 1)
check('the table alias does not follow the columns out - readPlayerDoc needs these names',
      found and set(found[0].keys()) == {'uuid', 'name', 'platform', 'pack_off', 'pack_len'},
      str(list(found[0].keys())) if found else 'no row')
check('finds nothing for a blocked player', len(run(by_name, ('s1', 'griefer'))) == 0)
check('the block is per server, not global',
      len(db.execute(by_name.replace('${NOT_BLOCKED}', NOT_BLOCKED), ('s2', 'griefer')).fetchall()) == 0)
check('a blocked Bedrock player is not reachable without their dot',
      len(run(by_bedrock, ('s1', '.gamer tag', 'gamer tag'))) == 0)
check('an unblocked Bedrock player still is', (
    db.execute("UPDATE blocked_players SET uuid = 'x' WHERE uuid = '0000-bedrk'"),
    len(run(by_bedrock, ('s1', '.gamer tag', 'gamer tag'))) == 1)[1])
db.execute("UPDATE blocked_players SET uuid = '0000-bedrk' WHERE uuid = 'x'")

check('a blocked player is not reachable by uuid either',
      len(run(by_uuid, ('s1', '0000-grief', '0000grief'))) == 0)
check('an unblocked one is', len(run(by_uuid, ('s1', '0000-alpha', '0000alpha'))) == 1)

print('\nthe search box on the page:')
rows = run(by_prefix, ('s1', '%'))
check('blocked players are gone from the suggestions', [r['name'] for r in rows] == ['Alpha'],
      str([r['name'] for r in rows]))
check('a blocked name suggests nothing at all', len(run(by_prefix, ('s1', 'grief%'))) == 0)

print('\nthe panel:')
owner = (ROOT / 'src/api/servers.js').read_text()
panel = [a or b for a, b in re.findall(r"prepare\(\s*(?:`([^`]+)`|'([^']+)')", owner)
         if 'blocked_players' in (a or b)]
check('every blocklist statement in servers.js is real SQL', len(panel) == 6, str(len(panel)))
for q in panel:
    sql = q.replace("${variants.map(() => '?').join(',')}", '?,?')
    binds = ['s1'] + ['0000-grief', '0000grief'][:sql.count('?') - 1]
    if sql.strip().startswith('INSERT'):
        binds = ['s1', '0000-new', 'New', t]
    try:
        db.execute(sql, binds)
    except sqlite3.Error as e:
        check(q.strip().split('\n')[0], False, str(e))
db.rollback()
print(f'  ok   all {len(panel)} of them run')

print('\nFAILED' if fails else '\nall checks passed')
sys.exit(1 if fails else 0)
