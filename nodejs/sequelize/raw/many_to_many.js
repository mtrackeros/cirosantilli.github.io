#!/usr/bin/env node

// https://cirosantilli.com/sql-example

const assert = require('assert');
const common = require('../common')
const sequelize = common.sequelize(__filename, process.argv[2])
common.assertEqual.typecast = { cnt: (s) => parseInt(s, 10) }
;(async () => {

// We do separate DROPs here because if one CREATE fails, we still
// want the other DROPs to run, even though one of them will fail.
// due to the table of the failed CREATE not existing.
await common.drop(sequelize, 'AnimalTag')
await common.drop(sequelize, 'Animal')
await common.drop(sequelize, 'Tag')
await Promise.all([
  `CREATE TABLE "Animal" (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE "Tag" (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)`,
].map(s => sequelize.query(s)))
await sequelize.query(`
CREATE TABLE "AnimalTag" (
  "animalId" INTEGER NOT NULL,
  "tagId" INTEGER NOT NULL,
  PRIMARY KEY ("animalId", "tagId"),
  FOREIGN KEY ("animalId") REFERENCES "Animal"(id) ON DELETE CASCADE,
  FOREIGN KEY ("tagId") REFERENCES "Tag"(id) ON DELETE CASCADE
)
`)
async function reset() {
  // Any of those also clears AnimalTag due to the CASCADE.
  await sequelize.query(`DELETE FROM "Animal"`)
  await sequelize.query(`DELETE FROM "Tag"`)
  // Trying to run both concurrently often leads to deadlocks
  // on PostgreSQL due to the concurrent CASCADEs on AnimalTag.
  //await Promise.all([`Animal`, `Tag`].map(s => sequelize.query(`DELETE FROM "${s}"`)))

  // We have to first insert Animal and Tag because AnimalTag
  // depend on it.
  await Promise.all([
    `
INSERT INTO "Animal" VALUES
(0, 'dog'),
(1, 'cat'),
(2, 'hawk'),
(3, 'bee')
`,
    `
INSERT INTO "Tag" VALUES
(0, 'flying'),
(1, 'mammal'),
(2, 'vertebrate'),
(3, 'aquatic')
`,
  ].map(s => sequelize.query(s)))
  return sequelize.query(`
INSERT INTO "AnimalTag" VALUES (0, 1),
(0, 2),
(1, 1),
(1, 2),
(2, 0),
(2, 2),
(3, 0)
`)
}
await reset()

let rows, meta

// Get all tags of all animals.
// This shows how in general JOIN returns repeated animal and tag rows.
;[rows, meta] = await sequelize.query(`
SELECT
  "Animal".name AS "Animal_name",
  "Tag".name AS "Tag_name"
FROM "Animal"
INNER JOIN "AnimalTag"
  ON "Animal"."id" = "AnimalTag"."animalId"
INNER JOIN "Tag"
  ON "AnimalTag"."tagId" = "Tag"."id"
ORDER BY "Animal"."id" ASC, "Tag"."id" ASC
`)
common.assertEqual(rows, [
  { Animal_name: 'dog', Tag_name: 'mammal' },
  { Animal_name: 'dog', Tag_name: 'vertebrate' },
  { Animal_name: 'cat', Tag_name: 'mammal' },
  { Animal_name: 'cat', Tag_name: 'vertebrate' },
  { Animal_name: 'hawk', Tag_name: 'flying' },
  { Animal_name: 'hawk', Tag_name: 'vertebrate' },
  { Animal_name: 'bee', Tag_name: 'flying' },
])

// Get all animals with the tag "flying".
;[rows, meta] = await sequelize.query(`
SELECT
  "Animal".name AS "Animal_name"
FROM "Animal"
INNER JOIN "AnimalTag"
  ON "Animal"."id" = "AnimalTag"."animalId"
INNER JOIN "Tag"
  ON "AnimalTag"."tagId" = "Tag".id
  AND "Tag".name = 'flying'
ORDER BY "Animal".id ASC
`)
common.assertEqual(rows, [
  { Animal_name: 'hawk' },
  { Animal_name: 'bee' },
])

// Get all tags of animal "dog"
;[rows, meta] = await sequelize.query(`
SELECT
  "Tag".name AS "Tag_name"
FROM "Tag"
INNER JOIN "AnimalTag"
  ON "Tag".id = "AnimalTag"."tagId"
INNER JOIN "Animal"
  ON "AnimalTag"."animalId" = "Animal".id
  AND "Animal".name = 'dog'
ORDER BY "Tag".id ASC
`)
common.assertEqual(rows, [
  { Tag_name: 'mammal' },
  { Tag_name: 'vertebrate' },
])

// Get all animals with tag "flying", but include all their other tags in the result as well
// https://stackoverflow.com/questions/25734598/get-all-posts-that-have-a-specific-tag-and-keep-all-other-tags-on-results-with-s/70435014#70435014
;[rows, meta] = await sequelize.query(`
SELECT
  "Animal".name AS "Animal_name",
  "Tag2".name AS "Tag_name"
FROM "Animal"
INNER JOIN "AnimalTag"
  ON "Animal"."id" = "AnimalTag"."animalId"
INNER JOIN "Tag"
  ON "AnimalTag"."tagId" = "Tag".id
  AND "Tag".name = 'flying'
INNER JOIN "AnimalTag" AS "AnimalTag2"
  ON "AnimalTag2"."animalId" = "Animal".id
INNER JOIN "Tag" AS "Tag2"
  ON "Tag2".id = "AnimalTag2"."tagId"
ORDER BY "Animal".id ASC, "Tag2".id ASC
`)
common.assertEqual(rows, [
  { Animal_name: 'hawk', Tag_name: 'flying' },
  { Animal_name: 'hawk', Tag_name: 'vertebrate' },
  { Animal_name: 'bee',  Tag_name: 'flying' },
])

// Get animal counts for each tag and order them in increasing order.
// Illustrates `GROUP BY` and getting other columns not in the GROUP BY
// which is possible because we are grouping by the PRIMARY KEY.
// https://dba.stackexchange.com/a/141600/33332
//
// If we grouped by "Tag".name it would fail on Postgres 13.5 with:
// > SequelizeDatabaseError: column "Tag.name" must appear in the GROUP BY clause or be used in an aggregate function
//
// Related example without JOIN: group_by_extra_column.js
//
// Ignores tags with zero animals due to INNER JOIN.
// https://dba.stackexchange.com/questions/174694/how-to-get-a-group-where-the-count-is-zero
;[rows, meta] = await sequelize.query(`
SELECT
  "Tag".id AS "id",
  "Tag".name AS "name",
  COUNT(*) AS "cnt"
FROM "Tag"
INNER JOIN "AnimalTag"
  ON "Tag"."id" = "AnimalTag"."tagId"
INNER JOIN "Animal"
  ON "AnimalTag"."animalId" = "Animal"."id"
GROUP BY "Tag"."id"
ORDER BY
  "cnt" DESC,
  "Tag".id ASC
`)
common.assertEqual(rows, [
  { name: 'vertebrate', cnt: 3 },
  { name: 'flying',     cnt: 2 },
  { name: 'mammal',     cnt: 2 },
])

// Same as above, but also consider tags with zero animals
// due to OUTER JOIN + COUNT(column)
;[rows, meta] = await sequelize.query(`
SELECT
  "Tag".name AS name,
  COUNT("Animal".id) AS cnt
FROM "Tag"
LEFT OUTER JOIN "AnimalTag"
  ON "Tag".id = "AnimalTag"."tagId"
LEFT OUTER JOIN "Animal"
  ON "AnimalTag"."animalId" = "Animal".id
GROUP BY "Tag".id
ORDER BY
  cnt DESC,
  "Tag".id ASC
`)
common.assertEqual(rows, [
  { name: 'vertebrate', cnt: 3 },
  { name: 'flying',     cnt: 2 },
  { name: 'mammal',     cnt: 2 },
  { name: 'aquatic',    cnt: 0 },
])

// Get animal counts for each tag that has less than 3 animals.
//
// This illustrates HAVING, which is what you have to do when dealing with aggregations:
// https://stackoverflow.com/questions/9253244/sql-having-vs-where
//
// Note that we cannot use the alias "cnt" in the HAVING:
// we just have to write COUNT(*) again there
// * https://dba.stackexchange.com/questions/281438/why-does-an-alias-with-a-having-clause-not-exist-in-postgresql
// * https://www.postgresqltutorial.com/postgresql-having/
//   "PostgreSQL evaluates the HAVING clause after the FROM, WHERE, GROUP BY, and before the SELECT, DISTINCT, ORDER BY and LIMIT clauses"
;[rows, meta] = await sequelize.query(`
SELECT
  "Tag".name AS name,
  COUNT(*) AS cnt
FROM "Tag"
INNER JOIN "AnimalTag"
  ON "Tag".id = "AnimalTag"."tagId"
INNER JOIN "Animal"
  ON "AnimalTag"."animalId" = "Animal".id
GROUP BY "Tag".id
HAVING
  COUNT(*) < 3
ORDER BY
  "cnt" DESC,
  "Tag".id ASC
`)
common.assertEqual(rows, [
  { name: 'flying', cnt: 2 },
  { name: 'mammal', cnt: 2 },
])

// Get animal counts only for the tags that are associated with 'dog'.
// Because SELECT must either contain aggregates or group by columns,
// we can't get names here unless:
// * we add a names to the GROUP BY. TODO wouldn't this would lead to slower evaluation, as it would have to both strings and integers, or strings rather than integers?
//   The optimizer could in principle however notice that because both names and IDs unique, that it can use the IDs for comparisons instead of names. But does it really?
// * TODO any other better possibility, either with joins or subqueries?
;[rows, meta] = await sequelize.query(`
SELECT
  COUNT(*) AS cnt,
  "AnimalTag2"."tagId" AS "tagId"
FROM "Animal"
INNER JOIN "AnimalTag"
  ON "Animal".name = 'dog'
  AND "Animal".id = "AnimalTag"."animalId"
INNER JOIN "Tag"
  ON "Tag".id = "AnimalTag"."tagId"
INNER JOIN "AnimalTag" AS "AnimalTag2"
  ON "AnimalTag2"."tagId" = "AnimalTag"."tagId"
GROUP BY "AnimalTag2"."tagId"
ORDER BY
  cnt DESC,
  "AnimalTag2"."tagId" ASC
`)
common.assertEqual(rows, [
  { tagId: 2, cnt: 3 },
  { tagId: 1, cnt: 2 },
])

// Same as above but use names in the JOIN instead of IDs.
;[rows, meta] = await sequelize.query(`
SELECT
  COUNT(*) AS cnt,
  "Tag".name AS name
FROM "Animal"
INNER JOIN "AnimalTag"
  ON "Animal".name = 'dog'
  AND "Animal".id = "AnimalTag"."animalId"
INNER JOIN "Tag"
  ON "Tag".id = "AnimalTag"."tagId"
INNER JOIN "AnimalTag" AS "AnimalTag2"
  ON "AnimalTag2"."tagId" = "AnimalTag"."tagId"
GROUP BY "Tag".name
ORDER BY
  cnt DESC,
  "Tag"."name" ASC
`)
common.assertEqual(rows, [
  { name: 'vertebrate', cnt: 3 },
  { name: 'mammal', cnt: 2 },
])

// Queries that modify data.

// UPDATE all tags of dog to uppercase.
// This is a simpler type of UPDATE where we just select what ill be updated,
// we don't need data from the JOIN for the update.
//
// Portable subquery version.
//
// Bibliography:
// * PostgreSQL https://stackoverflow.com/questions/7869592/how-to-do-an-update-join-in-postgresql
;[rows, meta] = await sequelize.query(`
UPDATE "Tag"
  SET "name" = UPPER(name)
WHERE "id" IN (
  SELECT "AnimalTag"."tagId"
  FROM "Animal"
  INNER JOIN "AnimalTag"
    ON "AnimalTag"."animalId" = "Animal"."id"
    AND "Animal"."name" = 'dog'
)
`)
;[rows, meta] = await sequelize.query(`SELECT * FROM "Tag" ORDER BY id ASC`)
common.assertEqual(rows, [
  { name: 'flying'     },
  { name: 'MAMMAL'     },
  { name: 'VERTEBRATE' },
  { name: 'aquatic'    },
])
await reset()

// Using PostgreSQL UPDATE JOIN extension
if (false) {
// TODO get working. Not going to use now because not portable to SQLite anyways
if (sequelize.options.dialect === 'postgres') {
  ;[rows, meta] = await sequelize.query(`
UPDATE "Tag" AS "Tag"
  SET name = UPPER("Tag2".name)
FROM "Tag" AS "Tag2"
INNER JOIN "AnimalTag"
  ON "Tag2"."id" = "AnimalTag"."tagId"
INNER JOIN "Animal"
  ON "AnimalTag"."animalId" = "Animal"."id"
  AND "Animal"."name" = 'dog'
`)
;[rows, meta] = await sequelize.query(`SELECT * FROM "Tag" ORDER BY id ASC`)
common.assertEqual(rows, [
  { name: 'flying'     },
  { name: 'MAMMAL'     },
  { name: 'VERTEBRATE' },
  { name: 'aquatic'    },
])
await reset()
}
}

// UPDATE all tags of dog to uppercase.
// This is a simpler type of UPDATE where we just select what ill be updated,
// we don't need data from the JOIN for the update.
//
// Portable subquery version.
;[rows, meta] = await sequelize.query(`
UPDATE "Tag"
  SET "name" = UPPER(name)
WHERE "id" IN (
  SELECT "AnimalTag"."tagId"
  FROM "Animal"
  INNER JOIN "AnimalTag"
    ON "AnimalTag"."animalId" = "Animal"."id"
    AND "Animal"."name" = 'dog'
)
`)
;[rows, meta] = await sequelize.query(`SELECT * FROM "Tag" ORDER BY id ASC`)
common.assertEqual(rows, [
  { name: 'flying'     },
  { name: 'MAMMAL'     },
  { name: 'VERTEBRATE' },
  { name: 'aquatic'    },
])
await reset()

// ON DELETE CASCADE action: if we delete the 'vertebrate' tag,
// corresponding relations are also deleted.
await sequelize.query(`DELETE FROM "Tag" WHERE id = 2`)
;[rows, meta] = await sequelize.query(`
SELECT * FROM "AnimalTag"
ORDER BY "animalId" ASC, "tagId" ASC
`)
common.assertEqual(rows, [
  { animalId: 0, tagId: 1 },
  { animalId: 1, tagId: 1 },
  { animalId: 2, tagId: 0 },
  { animalId: 3, tagId: 0 },
])
await reset()

// DELETE all animals with a given tag.
// DELETE + JOIN does not appear to be in the SQL standard, and sqlite 3.35 does not support it:
// ``
// near "INNER": syntax error
// ``
// so the only way is to do it with sub queries:
// https://stackoverflow.com/questions/24511153/how-delete-table-inner-join-with-other-table-in-sqlite
//
// PostgreSQL does have a non-standard USING syntax for it:
// https://stackoverflow.com/questions/11753904/postgresql-delete-with-inner-join
if (sequelize.options.dialect === 'postgres') {
  // JOIN version.
  await sequelize.query(`
DELETE FROM "Animal"
USING "AnimalTag", "Tag"
WHERE "Animal".id = "AnimalTag"."animalId"
  AND "AnimalTag"."tagId" = "Tag".id
  AND "Tag".name = 'flying'
`)
  ;[rows, meta] = await sequelize.query(`SELECT * FROM "Animal" ORDER BY id ASC`)
  common.assertEqual(rows, [
    { name: 'dog' },
    { name: 'cat' },
  ])
  await reset()
}

// Portable subquery version of the above.
await sequelize.query(`
DELETE FROM "Animal"
WHERE "Animal".id IN (
  SELECT
    "Animal".id
  FROM "Animal"
  INNER JOIN "AnimalTag"
    ON "Animal".id = "AnimalTag"."animalId"
  INNER JOIN "Tag"
    ON "AnimalTag"."tagId" = "Tag".id
    AND "Tag".name = 'flying'
)
`)
;[rows, meta] = await sequelize.query(`SELECT * FROM "Animal" ORDER BY id ASC`)
common.assertEqual(rows, [
  { name: 'dog' },
  { name: 'cat' },
])
await reset()

// Delete any tags associated with 'dog' that have less than 3 animals.
// In our specific test database, this should delete only the "mammal" tag.
// Application: with 1 instead of 3, we could use this to clean up possbly
// empty tags after deleting animal, as there might be no more associated animals
// to them after every animal deletion.
await sequelize.query(`
DELETE FROM "Tag"
WHERE "Tag".id IN (
  SELECT
    "AnimalTag2"."tagId"
  FROM "Animal"
  INNER JOIN "AnimalTag"
    ON "Animal".name = 'dog'
    AND "Animal".id = "AnimalTag"."animalId"
  INNER JOIN "Tag"
    ON "Tag".id = "AnimalTag"."tagId"
  INNER JOIN "AnimalTag" AS "AnimalTag2"
    ON "AnimalTag2"."tagId" = "AnimalTag"."tagId"
  GROUP BY "AnimalTag2"."tagId"
  HAVING
    COUNT(*) < 3
)
`)
;[rows, meta] = await sequelize.query(`SELECT * FROM "Tag" ORDER BY id ASC`)
common.assertEqual(rows, [
  { name: 'flying' },
  { name: 'vertebrate' },
  { name: 'aquatic' },
])
await reset()

})().finally(() => { return sequelize.close() });
