// Vitest setup — runs before each test file's imports. Forces the SQLite DB
// to :memory: so unit tests never create data/tagteam.db on disk. Individual
// tests that need a fresh empty DB call resetDb() in their beforeEach.
process.env.TAGTEAM_DB_PATH = process.env.TAGTEAM_DB_PATH || ':memory:';
