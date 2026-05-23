import MySQLConnection from '../database/mysql';
import { ReplicationMode } from '../database/databaseConfig';
import logger from '../logger';

export type KnownBlocker = {
  id: string;
  severity: 'info' | 'warn' | 'error';
  message: string;
  reference?: string;
};

export type ReplicationCapability = {
  /**
   * The recommended Phase-2 backend given the source MySQL's capability profile.
   * Always callable; falls back to 'polling' when binlog CDC isn't supported.
   */
  recommendedMode: Exclude<ReplicationMode, 'none'>;
  /**
   * True iff the source meets every requirement for PeerDB binlog CDC.
   */
  cdcSupported: boolean;
  /**
   * Human-readable reasons explaining why CDC was/wasn't recommended.
   * Surfaced via /api/databases/:id/replication-mode so operators can fix gaps.
   */
  reasons: string[];
  /**
   * Raw MySQL variable values inspected by the probe. Useful for diagnostics.
   */
  variables: {
    log_bin?: string | null;
    binlog_format?: string | null;
    binlog_row_image?: string | null;
    binlog_row_metadata?: string | null;
    gtid_mode?: string | null;
  };
  /**
   * The raw grant lines returned by `SHOW GRANTS FOR CURRENT_USER()`.
   */
  grants: string[];
  /**
   * Known caveats that don't block CDC at the protocol level but are worth
   * surfacing to operators (e.g. data-fidelity issues in the chosen backend).
   * `severity: 'error'` indicates the operator should NOT adopt that backend
   * without a workaround.
   */
  knownBlockers: KnownBlocker[];
};

const REQUIRED_GRANTS = ['REPLICATION SLAVE', 'REPLICATION CLIENT'];

/**
 * Probe a MySQL source for binlog-CDC capability. PeerDB needs ROW-format
 * binlogs with FULL row image *and* FULL metadata, plus REPLICATION SLAVE and
 * REPLICATION CLIENT on the connecting user. Anything missing → fall back to
 * the in-repo polling backend.
 */
export async function detectReplicationCapability(mysql: MySQLConnection): Promise<ReplicationCapability> {
  const [log_bin, binlog_format, binlog_row_image, binlog_row_metadata, gtid_mode] = await Promise.all([
    mysql.getVariable('log_bin'),
    mysql.getVariable('binlog_format'),
    mysql.getVariable('binlog_row_image'),
    mysql.getVariable('binlog_row_metadata'),
    mysql.getVariable('gtid_mode'),
  ]);

  const grants = await mysql.getCurrentUserGrants();

  const reasons: string[] = [];

  const isOn = (value: string | null): boolean =>
    value !== null && /^(ON|1)$/i.test(String(value).trim());
  const equalsCi = (value: string | null, expected: string): boolean =>
    value !== null && String(value).trim().toUpperCase() === expected.toUpperCase();
  const hasGrant = (substring: string): boolean =>
    grants.some((line) => line.toUpperCase().includes(substring.toUpperCase()));

  if (!isOn(log_bin)) reasons.push(`log_bin is not ON (got '${log_bin ?? 'unknown'}')`);
  if (!equalsCi(binlog_format, 'ROW')) reasons.push(`binlog_format must be ROW (got '${binlog_format ?? 'unknown'}')`);
  if (!equalsCi(binlog_row_image, 'FULL')) reasons.push(`binlog_row_image must be FULL (got '${binlog_row_image ?? 'unknown'}')`);
  if (!equalsCi(binlog_row_metadata, 'FULL')) {
    reasons.push(`binlog_row_metadata must be FULL for PeerDB (got '${binlog_row_metadata ?? 'unknown'}')`);
  }

  const missingGrants = REQUIRED_GRANTS.filter((grant) => !hasGrant(grant));
  if (missingGrants.length > 0) {
    reasons.push(
      `MySQL user is missing global grants required for binlog CDC: ${missingGrants.join(', ')}. ` +
      `Run: GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO '<user>'@'%';`,
    );
  }

  const cdcSupported = reasons.length === 0;
  if (cdcSupported) {
    reasons.push('Source supports binlog CDC.');
  }

  // Known PeerDB caveats — surfaced regardless of capability so operators
  // see them in /api/databases/:id/replication-mode before adopting the
  // backend. Severity 'warn' means "you'll hit this, plan a mitigation";
  // 'error' means "this corrupts data, don't ship without a workaround".
  const knownBlockers: KnownBlocker[] = [
    {
      id: 'peerdb-mysql-zero-date',
      severity: 'warn',
      message:
        "PeerDB's ClickHouse target does not faithfully round-trip MySQL " +
        "0000-00-00 / 1000-01-01 date values; they may surface as 1970-01-01. " +
        'See docs/peerdb-upstream-zero-date-patch.md for the local POC patch ' +
        'and the upstream tracking link. The in-repo polling backend handles ' +
        'these by emitting NULL.',
      reference: 'docs/peerdb-upstream-zero-date-patch.md',
    },
  ];

  return {
    recommendedMode: cdcSupported ? 'peerdb' : 'polling',
    cdcSupported,
    reasons,
    variables: { log_bin, binlog_format, binlog_row_image, binlog_row_metadata, gtid_mode },
    grants,
    knownBlockers,
  };
}

export async function safeDetectReplicationCapability(
  mysql: MySQLConnection,
): Promise<ReplicationCapability> {
  try {
    return await detectReplicationCapability(mysql);
  } catch (error) {
    logger.warn('Replication capability probe failed; assuming polling fallback', { error });
    return {
      recommendedMode: 'polling',
      cdcSupported: false,
      reasons: [`probe failed: ${error instanceof Error ? error.message : String(error)}`],
      variables: {},
      grants: [],
      knownBlockers: [],
    };
  }
}
