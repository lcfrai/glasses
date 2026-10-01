import test from 'node:test';
import assert from 'node:assert/strict';
import {hasPublicReleaseCredentialPattern as containsCredential} from '../scripts/lib/public-release-privacy.mjs';

test('publication audit accepts long Zygisk filenames without matching inside the word',()=>{
  const filename='zygisk-'+['synthetic','fingerprint','payment','android','release'].join('-')+'.zip';
  assert.equal(containsCredential(`Install ${filename} using your module manager.`),false);
  assert.equal(containsCredential(JSON.stringify({sections:[{summary:`Download ${filename}.`}]})),false);
});

test('publication audit rejects token-shaped strings in source prose, JSON and URLs',()=>{
  const tokens=['sk-'+'x'.repeat(32),...['p','o','u','s','r'].map(kind=>'gh'+kind+'_'+'x'.repeat(25))];
  for(const token of tokens)for(const context of [token,`Bearer ${token}`,JSON.stringify({key:token}),`https://example.org/${token}`,`https://example.org/?key=${token}`,`KEY=${token}`]){
    assert.equal(containsCredential(context),true);
  }
});

test('publication audit retains private-key header rejection and is repeatable',()=>{
  for(const kind of ['', 'RSA ', 'EC ', 'OPENSSH ']){
    const header=['-----BEGIN ',kind,'PRIVATE KEY','-----'].join('');
    assert.equal(containsCredential(header),true);
    assert.equal(containsCredential(header),true);
  }
  assert.equal(containsCredential('A documented public source with no credential.'),false);
});
