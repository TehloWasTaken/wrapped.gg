"""Runs the statements the birthday and rank-movement code issues, against the real schema.

Same approach as admin-sql.py: build the database from the migrations, put one
of everything in it, and execute each query with representative binds. D1 is
SQLite, so these are the queries that ship rather than approximations, and it
needs no Cloudflare account, no wrangler and no workerd.

Small, because the two features are small in the database. The birthday is one
nullable column read through `liveServer`; rank movement is one lookup - "which
build am I about to replace, and was it cut the same way" - and stores nothing
here at all, because the ranks live in R2 next to the build they came from.

    python3 test/birthday-sql.py
"""
import sqlite3, time, pathlib, sys

M = pathlib.Path(__file__).resolve().parent.parent / 'migrations'
db = sqlite3.connect(':memory:')
db.row_factory = sqlite3.Row
MIGRATIONS = ['0001_init.sql', '0002_partners.sql', '0003_admin.sql',
              '0004_usercache.sql', '0005_birthday.sql']
for f in MIGRATIONS:
    db.executescript((M / f).read_text())
db.execute('PRAGMA foreign_keys = ON')
print('schema: ok (' + ' + '.join(f[:4] for f in MIGRATIONS) + ')')

t = int(time.time())
WEEK = 7 * 86400

fails = []
def check(label, cond, detail=''):
    print(('  ok   ' if cond else '  FAIL ') + label + (('  ' + detail) if detail and not cond else ''))
    if not cond:
        fails.append(label)

db.executescript(f"""
INSERT INTO users VALUES ('u_a','111','alice',NULL,{t},{t});

INSERT INTO servers (id,slug,name,owner_id,palette,published,created_at,updated_at,world_born_at)
VALUES ('s_old','northwind-ab12c','Northwind','u_a',0,1,{t},{t},{t - 400 * 86400});
INSERT INTO servers (id,slug,name,owner_id,palette,published,created_at,updated_at,world_born_at)
VALUES ('s_new','survival-zz99y','Survival','u_a',3,1,{t},{t},NULL);

INSERT INTO snapshots VALUES ('sn0','s_old','snapshots/s_old/0','i0',{t - WEEK},{t - WEEK},'shell',10,900,'ready',NULL,{t - WEEK});
INSERT INTO snapshots VALUES ('sn1','s_old','snapshots/s_old/1','i1',{t},{t},'shell',10,900,'ready',NULL,{t});
INSERT INTO snapshots VALUES ('sn2','s_new','snapshots/s_new/1','i2',{t},{t},'shell',10,900,'ready',NULL,{t});

INSERT INTO builds VALUES ('b_prev','s_old',NULL,'sn0',NULL,{t - WEEK},3269,{t - WEEK},0);
INSERT INTO builds VALUES ('b_live','s_old',NULL,'sn1',NULL,{t},3269,{t},1);
INSERT INTO builds VALUES ('b_base','s_new','sn2','sn2',NULL,{t},10,{t},1);
""")
db.commit()
print('fixtures: ok')

def one(sql, args=()):
    return db.execute(sql, args).fetchone()

print('\nworld birthday')

LIVE = """SELECT s.id, s.slug, s.name, s.description, s.palette, s.published, s.icon_key,
                 s.world_born_at,
                 b.id AS build_id, b.players, b.created_at AS built_at
            FROM servers s
            LEFT JOIN builds b ON b.server_id = s.id AND b.is_live = 1
           WHERE s.slug = ?"""
check('liveServer carries world_born_at', one(LIVE, ('northwind-ab12c',))['world_born_at'] is not None)
check('and null is a perfectly good answer', one(LIVE, ('survival-zz99y',))['world_born_at'] is None)
check('a server with no live build still resolves',
      one(LIVE, ('northwind-ab12c',))['build_id'] == 'b_live')

db.execute('UPDATE servers SET world_born_at = ?, updated_at = ? WHERE id = ?',
           (t - 900 * 86400, t, 's_new'))
check('the panel can set it', one(LIVE, ('survival-zz99y',))['world_born_at'] == t - 900 * 86400)
db.execute('UPDATE servers SET world_born_at = ?, updated_at = ? WHERE id = ?', (None, t, 's_new'))
check('and clear it again', one(LIVE, ('survival-zz99y',))['world_born_at'] is None)

check('the panel sees it in the server list',
      'world_born_at' in one("""SELECT s.*,
             (SELECT COUNT(*) FROM snapshots sn WHERE sn.server_id = s.id) AS snapshots,
             (SELECT players FROM builds b WHERE b.server_id = s.id AND b.is_live = 1) AS live_players
        FROM servers s WHERE s.owner_id = ? ORDER BY s.created_at DESC""", ('u_a',)).keys())
db.commit()

print('\nrank movement')

PREV = """SELECT id, baseline_id, players, created_at FROM builds
           WHERE server_id = ? AND is_live = 1"""
prev = one(PREV, ('s_old',))
check('finds the build about to be replaced', prev is not None and prev['id'] == 'b_live')
check('and how long ago it was', prev['created_at'] == t)
check('and how big it was, so the memory guard can refuse it', prev['players'] == 3269)
check('a server that has never built has nothing to compare against',
      one(PREV, ('s_missing',)) is None)

check('a nominated baseline is visible on the build row', one(PREV, ('s_new',))['baseline_id'] == 'sn2')
check('and differs from a build with none', prev['baseline_id'] is None)

kept = db.execute("""SELECT id FROM builds WHERE server_id = ? AND id != ?
                      ORDER BY created_at DESC LIMIT 20 OFFSET 1""",
                  ('s_old', 'b_live')).fetchall()
check('pruning spares the build movement is measured from',
      'b_prev' not in [r['id'] for r in kept])

print('\n' + ('FAILED: ' + ', '.join(fails) if fails else 'all birthday and movement queries ok'))
sys.exit(1 if fails else 0)
