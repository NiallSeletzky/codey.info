"""Run disposable PHP HTTP/API and worker tests. No model calls or hosting access.

Requires Python 3 and PHP 8.2+ with PDO SQLite. Production uses MySQL/MariaDB.
Set PHP_TEST_COMMAND to a shell-like command if PHP needs explicit extensions.
"""
import http.cookiejar
import json
import os
import pathlib
import re
import shlex
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
PHP = shlex.split(os.environ.get('PHP_TEST_COMMAND', 'php'))
SECRET = 'local-test-secret-' + 'a' * 40
COUNT = 0

def check(condition, label):
    global COUNT
    assert condition, label
    COUNT += 1
    print('PASS', label)

with tempfile.TemporaryDirectory(prefix='codey-test-') as tmp:
    root = pathlib.Path(tmp)
    shutil.copytree(ROOT / 'codey', root / 'codey')
    shutil.copytree(ROOT / 'codey-private', root / 'codey-private')
    database = root / 'test.sqlite'
    schema = (ROOT / 'schema.sql').read_text()
    schema = re.sub(r'BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY', 'INTEGER PRIMARY KEY AUTOINCREMENT', schema)
    schema = schema.replace('BIGINT UNSIGNED', 'INTEGER')
    schema = re.sub(r',\s*INDEX\([^)]*\)', '', schema)
    schema = schema.replace('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4', '')
    conn = sqlite3.connect(database)
    conn.executescript(schema)
    conn.close()

    def config(local=True):
        (root / 'codey-private/config.php').write_text("<?php return " +
            "['dsn'=>'sqlite:" + str(database) + "','db_user'=>'','db_password'=>''," +
            "'setup_secret'=>'" + SECRET + "','allow_local_http'=>" + ('true' if local else 'false') +
            ",'ai'=>['key'=>'','endpoint'=>'https://api.x.ai/v1/chat/completions','model'=>'test'," +
            "'daily_call_limit'=>12,'round_interval_seconds'=>21600,'timeout_seconds'=>35,'max_completion_tokens'=>800]];")
    config()
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    log = open(root / 'server.log', 'w+')
    server = subprocess.Popen(PHP + ['-S', f'127.0.0.1:{port}', '-t', str(root / 'codey')], stdout=log, stderr=log)
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    csrf = ''

    def request(action, data=None, *, token=None, use_csrf=True, status=200, params=''):
        headers = {}
        if data is not None:
            headers['Content-Type'] = 'application/json'
            if use_csrf:
                headers['X-CSRF-Token'] = csrf
        if token:
            headers['Authorization'] = 'Bearer ' + token
        req = urllib.request.Request(f'http://127.0.0.1:{port}/api.php?action={action}{params}',
            data=None if data is None else json.dumps(data).encode(), headers=headers)
        try:
            response = opener.open(req, timeout=10)
        except urllib.error.HTTPError as e:
            response = e
        raw = response.read()
        try: body = json.loads(raw)
        except json.JSONDecodeError: raise AssertionError(raw.decode())
        assert response.code == status, (action, response.code, body)
        return body

    def dbexec(query, params=()):
        with sqlite3.connect(database) as c:
            cur = c.execute(query, params)
            return cur.fetchall()

    def worker(mode='success'):
        script = root / 'runner.php'
        function = "throw new RuntimeException('mock failure');" if mode == 'fail' else "return ['reply'=>'A tested reply from '.$bot['handle'], 'memory'=>'I offered a tested thought in this conversation.', 'input_tokens'=>50, 'output_tokens'=>20];"
        script.write_text("<?php require __DIR__.'/codey-private/worker.php'; echo json_encode(workerTick(function($bot,$topic,$posts,$memories){" + function + "}));")
        result = subprocess.run(PHP + [str(script)], capture_output=True, text=True)
        assert result.returncode == 0, result.stdout + result.stderr
        return json.loads(result.stdout)

    try:
        for _ in range(60):
            try:
                st = request('state'); break
            except (urllib.error.URLError, ConnectionError):
                time.sleep(.1)
        else:
            raise AssertionError('PHP did not start')
        csrf = st['csrf']
        check(not st['installed'], 'fresh installation is not open for posting')
        request('setup', {'secret':'bad', 'handle':'James', 'password':'test-password-long'}, status=403)
        request('setup', {'secret':SECRET, 'handle':'James', 'password':'test-password-long'})
        request('setup', {'secret':SECRET, 'handle':'Another', 'password':'test-password-long'}, status=409)
        check(request('state')['installed'], 'setup is one-time and creates the forum')
        request('login', {'handle':'James', 'password':'test-password-long'})
        st = request('state'); csrf = st['csrf']
        check(st['user']['is_admin'] == 1 and 'password_hash' not in st['user'], 'keeper login exposes no password hash')
        request('topic', {'board_id':1,'title':'No token','body':'test'}, use_csrf=False, status=403)
        check(True, 'session writes require CSRF token')
        first = request('topic', {'board_id':1,'title':'What should bots remember?','body':'Let us discuss memory.'})['topic_id']
        second = request('topic', {'board_id':2,'title':'Separate workshop','body':'Another topic.'})['topic_id']
        opening = request('posts', params=f'&topic_id={first}')['posts'][0]['id']
        account = request('account', {'kind':'bot','handle':'Scout','persona':'Curious visiting researcher.'})
        key = account['api_key']
        reply = {'topic_id':first,'parent_id':opening,'body':'<script>alert(1)</script> is plain text.','request_key':'scout-message-0001'}
        p = request('post', reply, token=key)['post_id']
        again = request('post', reply, token=key)['post_id']
        check(p == again, 'retried external bot posts are idempotent')
        request('post', {**reply,'body':'Changed'}, token=key, status=409)
        request('post', {**reply,'topic_id':second,'request_key':'cross-thread-0001'}, token=key, status=422)
        check(True, 'conflicting idempotency keys and cross-topic replies rejected')
        request('autopilot', {'enabled':True}, token=key, status=403)
        check(True, 'external bots cannot administer the forum')
        request('memory', {'bot_id':2,'source_post_id':p,'summary':'I discussed how text should be displayed.'}, token=key)
        notes = request('memories', params=f'&bot_id={account["id"]}')['memories']
        check(len(notes) == 1 and notes[0]['bot_id'] == account['id'], 'bot memory is attributed to its authenticated identity')
        check(len(request('memories', params='&bot_id=2')['memories']) == 0, 'bots cannot write another bot’s memories')
        request('hide_post', {'post_id':p})
        check(not request('memories', params=f'&bot_id={account["id"]}')['memories'], 'hidden source posts are excluded from visible memories')
        key2 = request('rotate_key', {'bot_id':account['id']})['api_key']
        request('post', {**reply,'request_key':'revoked-key-0001'}, token=key, status=401)
        request('account_status', {'user_id':account['id'],'active':False,'autonomous':False})
        request('post', {**reply,'request_key':'disabled-key-0001'}, token=key2, status=401)
        check(True, 'key replacement and account disable take effect immediately')
        request('topic_status', {'topic_id':second,'locked':True,'bots_enabled':False})
        request('post', {'topic_id':second,'body':'No','request_key':'locked-topic-0001'}, status=409)
        check(True, 'locked topics reject new posts')
        config(False)
        request('post', {'topic_id':first,'body':'No','request_key':'http-write-0001'}, status=426)
        config()
        check(True, 'production configuration rejects HTTP writes')
        request('round', {'topic_id':first})
        check(worker()['status'] == 'paused', 'worker defaults to paused with no model call')
        request('autopilot', {'enabled':True})
        result = worker()
        check(result['status'] == 'complete', 'scheduled worker completes a single bot turn')
        check(len(dbexec('SELECT id FROM memories WHERE bot_id=2')) == 1, 'worker publishes a sourced memory with the reply')
        check(worker()['status'] == 'complete', 'next process continues the queued conversation')
        count_before = len(dbexec('SELECT id FROM posts'))
        failed = worker('fail')
        check(failed['status'] == 'failed' and len(dbexec('SELECT id FROM posts')) == count_before, 'failed model call publishes no partial post')
        check(worker()['status'] == 'idle', 'failed jobs are not silently retried')
        request('job_action', {'job_id':failed['job_id'],'operation':'retry'})
        check(worker()['status'] == 'complete', 'keeper can explicitly retry a failed job')
        request('round', {'topic_id':first})
        next_id = dbexec("SELECT id FROM jobs WHERE status='pending' ORDER BY id LIMIT 1")[0][0]
        dbexec("UPDATE jobs SET status='running',started_at=? WHERE id=?", (int(time.time())-200,next_id))
        check(worker()['status'] == 'idle' and dbexec('SELECT status FROM jobs WHERE id=?',(next_id,))[0][0] == 'uncertain', 'interrupted calls stop the topic queue pending inspection')
        request('job_action', {'job_id':next_id,'operation':'cancel'})
        calls = dbexec('SELECT COUNT(*) FROM ai_calls')[0][0]
        for _ in range(12-calls):
            dbexec("INSERT INTO ai_calls(job_id,created_at,status) VALUES (?,?,'reserved')", (next_id,int(time.time())))
        check(worker()['status'] == 'daily call limit reached', 'daily call limit counts failed and uncertain attempts')
        check('input_tokens' not in json.dumps(request('state')), 'public state does not expose private operational data')
        print(f'\n{COUNT} integration checks passed. SQLite test adapter; no paid API calls.')
    finally:
        server.terminate()
        server.wait(timeout=10)
        log.close()
