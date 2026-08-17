/* Contract tests for the provider registry and role resolution (src/lib/ai/config.ts).
 *
 * The load-bearing property under test everywhere below: missing configuration resolves to
 * null, never to a guessed value. That is what makes a wrong or absent env var a clean 503
 * upstream rather than a request silently sent to the wrong host with a real credential.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider, resolveRole, resolveRoleFully, ROLES } from './config.ts';

/* Sets exactly the given env vars for the duration of `run`, restoring each key's original
   value (or absence) afterward — never a blanket process.env swap, so this can't accidentally
   mask an unrelated env var some other module depends on mid-suite. */
function withEnv(vars, run) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── resolveProvider ────────────────────────────────────────────────────────────────────────

test('resolveProvider: an unknown provider name is null, not a lookup crash', () => {
  assert.equal(resolveProvider('not-a-real-provider'), null);
});

test('resolveProvider: nebius/minimax resolve nothing until BOTH base URL and key are set — no guessed URL', () => {
  withEnv({ NEBIUS_BASE_URL: undefined, NEBIUS_API_KEY: undefined }, () => {
    assert.equal(resolveProvider('nebius'), null, 'nothing set');
  });
  withEnv({ NEBIUS_BASE_URL: undefined, NEBIUS_API_KEY: 'k' }, () => {
    assert.equal(resolveProvider('nebius'), null, 'key alone must not resolve — no default base URL to fall back to');
  });
  withEnv({ NEBIUS_BASE_URL: 'https://example.test/v1', NEBIUS_API_KEY: undefined }, () => {
    assert.equal(resolveProvider('nebius'), null, 'base URL alone is not enough either');
  });
});

test('resolveProvider: nebius resolves once both are explicitly configured', () => {
  withEnv({ NEBIUS_BASE_URL: 'https://example.test/v1', NEBIUS_API_KEY: 'k' }, () => {
    assert.deepEqual(resolveProvider('nebius'), {
      name: 'nebius',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
    });
  });
});

test('resolveProvider: minimax behaves identically to nebius — no built-in default either', () => {
  withEnv({ MINIMAX_BASE_URL: undefined, MINIMAX_API_KEY: 'k' }, () => {
    assert.equal(resolveProvider('minimax'), null);
  });
});

test('resolveProvider: noinfra defaults to the verified base URL when unset, but still needs a key', () => {
  withEnv({ NOINFRA_BASE_URL: undefined, NOINFRA_API_KEY: undefined }, () => {
    assert.equal(resolveProvider('noinfra'), null, 'a default base URL is not a default key');
  });
  withEnv({ NOINFRA_BASE_URL: undefined, NOINFRA_API_KEY: 'k' }, () => {
    assert.deepEqual(resolveProvider('noinfra'), {
      name: 'noinfra',
      baseUrl: 'https://inference.noinfra.ai/v1',
      apiKey: 'k',
    });
  });
});

test('resolveProvider: NOINFRA_BASE_URL overrides the verified default rather than being ignored', () => {
  withEnv({ NOINFRA_BASE_URL: 'https://staging.example.test/v1', NOINFRA_API_KEY: 'k' }, () => {
    assert.equal(resolveProvider('noinfra').baseUrl, 'https://staging.example.test/v1');
  });
});

// ── resolveRole ────────────────────────────────────────────────────────────────────────────

test('ROLES lists exactly the four roles ARCHITECTURE.md §4.5 configures', () => {
  assert.deepEqual([...ROLES].sort(), ['interpret', 'plan', 'synthesis', 'verify']);
});

for (const role of ['interpret', 'plan', 'synthesis', 'verify']) {
  test(`resolveRole('${role}'): reads CARIBECON_${role.toUpperCase()}_PROVIDER/_MODEL specifically`, () => {
    withEnv(
      { [`CARIBECON_${role.toUpperCase()}_PROVIDER`]: 'nebius', [`CARIBECON_${role.toUpperCase()}_MODEL`]: 'test-model' },
      () => {
        assert.deepEqual(resolveRole(role), { role, provider: 'nebius', model: 'test-model' });
      },
    );
  });
}

test('resolveRole: null when the provider env var is unset', () => {
  withEnv({ CARIBECON_INTERPRET_PROVIDER: undefined, CARIBECON_INTERPRET_MODEL: 'x' }, () => {
    assert.equal(resolveRole('interpret'), null);
  });
});

test('resolveRole: null when the model env var is unset — a provider alone is not a role config', () => {
  withEnv({ CARIBECON_INTERPRET_PROVIDER: 'nebius', CARIBECON_INTERPRET_MODEL: undefined }, () => {
    assert.equal(resolveRole('interpret'), null);
  });
});

test('resolveRole: an unrecognised provider name never resolves, even with a model set — never invented, never a fuzzy match', () => {
  withEnv({ CARIBECON_INTERPRET_PROVIDER: 'nebiuss', CARIBECON_INTERPRET_MODEL: 'x' }, () => {
    assert.equal(resolveRole('interpret'), null);
  });
});

test('resolveRole: distinct roles read distinct env vars — synthesis is not accidentally verify', () => {
  withEnv(
    {
      CARIBECON_SYNTHESIS_PROVIDER: 'nebius',
      CARIBECON_SYNTHESIS_MODEL: 'synth-model',
      CARIBECON_VERIFY_PROVIDER: 'minimax',
      CARIBECON_VERIFY_MODEL: 'verify-model',
    },
    () => {
      assert.deepEqual(resolveRole('synthesis'), { role: 'synthesis', provider: 'nebius', model: 'synth-model' });
      assert.deepEqual(resolveRole('verify'), { role: 'verify', provider: 'minimax', model: 'verify-model' });
    },
  );
});

// ── resolveRoleFully ───────────────────────────────────────────────────────────────────────

test('resolveRoleFully: null when the role resolves but the provider connection does not', () => {
  withEnv(
    {
      CARIBECON_INTERPRET_PROVIDER: 'nebius',
      CARIBECON_INTERPRET_MODEL: 'x',
      NEBIUS_BASE_URL: undefined,
      NEBIUS_API_KEY: undefined,
    },
    () => {
      assert.equal(resolveRoleFully('interpret'), null);
    },
  );
});

test('resolveRoleFully: null when the role itself is unconfigured, regardless of the provider', () => {
  withEnv(
    {
      CARIBECON_INTERPRET_PROVIDER: undefined,
      CARIBECON_INTERPRET_MODEL: undefined,
      NEBIUS_BASE_URL: 'https://example.test/v1',
      NEBIUS_API_KEY: 'k',
    },
    () => {
      assert.equal(resolveRoleFully('interpret'), null);
    },
  );
});

test('resolveRoleFully: the full chain, role config plus a ready-to-call connection', () => {
  withEnv(
    {
      CARIBECON_INTERPRET_PROVIDER: 'noinfra',
      CARIBECON_INTERPRET_MODEL: 'small',
      NOINFRA_BASE_URL: undefined,
      NOINFRA_API_KEY: 'k',
    },
    () => {
      assert.deepEqual(resolveRoleFully('interpret'), {
        role: 'interpret',
        provider: 'noinfra',
        model: 'small',
        connection: { name: 'noinfra', baseUrl: 'https://inference.noinfra.ai/v1', apiKey: 'k' },
      });
    },
  );
});
