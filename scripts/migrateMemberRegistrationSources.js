'use strict';

const db = require('../src/config/db');

async function main() {
  let connection;

  try {
    connection = await db.getConnection();

    const [columns] = await connection.query(
      "SHOW COLUMNS FROM members LIKE 'registration_source'"
    );

    if (columns.length !== 1) {
      throw new Error('members.registration_source was not found.');
    }

    const column = columns[0];
    const enumMatch = String(column.Type).match(/^enum\((.*)\)$/i);

    if (!enumMatch) {
      throw new Error(`Expected ENUM type, found ${column.Type}`);
    }

    const currentValues = Array.from(
      enumMatch[1].matchAll(/'((?:\\.|[^'])*)'/g),
      (item) => item[1].replace(/\\'/g, "'")
    );

    const allowed = [
      'walk_in',
      'referral',
      'friend',
      'facebook',
      'social_media',
      'website',
      'other',
    ];

    const unknown = currentValues.filter(
      (value) => !allowed.includes(value)
    );

    if (unknown.length > 0) {
      throw new Error(
        `Unexpected ENUM values; refusing to remove them: ${unknown.join(', ')}`
      );
    }

    const values = allowed.filter(
      (value) =>
        currentValues.includes(value) ||
        value === 'friend' ||
        value === 'social_media'
    );

    const defaultValue =
      column.Default == null ? null : String(column.Default);

    if (defaultValue !== null && !values.includes(defaultValue)) {
      throw new Error(`Unexpected ENUM default: ${defaultValue}`);
    }

    const enumSql = values.map((value) => `'${value}'`).join(', ');
    const nullSql = column.Null === 'YES' ? 'NULL' : 'NOT NULL';
    const defaultSql =
      defaultValue === null ? '' : ` DEFAULT '${defaultValue}'`;

    await connection.query(
      `ALTER TABLE members
       MODIFY COLUMN registration_source
       ENUM(${enumSql}) ${nullSql}${defaultSql}`
    );

    const [verified] = await connection.query(
      "SHOW COLUMNS FROM members LIKE 'registration_source'"
    );

    const type = String(verified[0].Type);

    if (!type.includes("'friend'") || !type.includes("'social_media'")) {
      throw new Error('Registration source ENUM verification failed.');
    }

    console.log('Registration source migration completed.');
    console.log(`Verified: ${type}`);
  } finally {
    if (connection) connection.release();
    if (typeof db.end === 'function') await db.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });