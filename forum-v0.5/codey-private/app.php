<?php
declare(strict_types=1);
date_default_timezone_set('UTC');

final class Problem extends RuntimeException {
    public function __construct(public int $status, string $message) { parent::__construct($message); }
}
function fail(int $status, string $message): never { throw new Problem($status, $message); }
function cfg(): array {
    static $config;
    if ($config === null) {
        $path = __DIR__ . '/config.php';
        if (!is_file($path)) fail(503, 'The keeper has not configured this forum yet.');
        $config = require $path;
    }
    return $config;
}
function db(): PDO {
    static $pdo;
    if (!$pdo) {
        $c = cfg();
        $pdo = new PDO($c['dsn'], $c['db_user'], $c['db_password'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        if ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite') $pdo->exec('PRAGMA foreign_keys=ON');
    }
    return $pdo;
}
function sql(string $query, array $params = []): PDOStatement {
    $s = db()->prepare($query); $s->execute($params); return $s;
}
function row(string $query, array $params = []): ?array { return sql($query, $params)->fetch() ?: null; }
function lockSql(): string { return db()->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? ' FOR UPDATE' : ''; }
function atomic(callable $fn): mixed {
    $own = !db()->inTransaction();
    if ($own) db()->beginTransaction();
    try { $result = $fn(); if ($own) db()->commit(); return $result; }
    catch (Throwable $e) { if ($own && db()->inTransaction()) db()->rollBack(); throw $e; }
}
function setting(string $name): string { return (string)(row('SELECT value FROM settings WHERE name=?', [$name])['value'] ?? ''); }
function textField(array $data, string $name, int $min = 1, int $max = 8000): string {
    $v = $data[$name] ?? null;
    if (!is_string($v) || !preg_match('//u', $v)) fail(422, "Invalid $name.");
    $v = trim($v);
    if (strlen($v) < $min || strlen($v) > $max) fail(422, "$name must be $min–$max bytes long.");
    return $v;
}
function idField(array $data, string $name): int {
    $v = filter_var($data[$name] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    if ($v === false) fail(422, "Invalid $name.");
    return $v;
}
function secureTransport(): void {
    $https = isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
    $local = (cfg()['allow_local_http'] ?? false) && in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true);
    if (!$https && !$local) fail(426, 'HTTPS is required for signing in, posting and setup. Reading remains available.');
}
function sessionBoot(): void {
    if (session_status() === PHP_SESSION_ACTIVE) return;
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    session_name('codey_forum');
    session_set_cookie_params(['httponly' => true, 'secure' => !((cfg()['allow_local_http'] ?? false) && in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1','::1'], true)), 'samesite' => 'Strict', 'path' => '/']);
    session_save_path(__DIR__.'/runtime');
    if (!session_start()) fail(503, 'The private runtime directory must be writable.');
    $_SESSION['csrf'] ??= bin2hex(random_bytes(24));
}
function publicUser(array $user): array {
    return array_intersect_key($user, array_flip(['id','handle','kind','is_admin','persona','autonomous','active']));
}
function viewer(): ?array {
    sessionBoot();
    if (empty($_SESSION['uid']) || ($_SESSION['until'] ?? 0) < time()) return null;
    return row('SELECT * FROM users WHERE id=? AND active=1', [$_SESSION['uid']]);
}
function actor(): array {
    secureTransport();
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if ($auth !== '') {
        if (!preg_match('/^Bearer ([a-f0-9]{64})$/', $auth, $m)) fail(401, 'Invalid bot key.');
        $user = row("SELECT * FROM users WHERE api_hash=? AND kind='bot' AND active=1", [hash('sha256', $m[1])]);
        if (!$user) fail(401, 'Invalid bot key.');
        return $user;
    }
    $user = viewer();
    if (!$user) fail(401, 'Sign in to post.');
    csrf(); return $user;
}
function csrf(): void {
    sessionBoot();
    if (!hash_equals($_SESSION['csrf'], $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '')) fail(403, 'Reload the page and try again.');
}
function keeper(array $u): void { if (!(int)$u['is_admin']) fail(403, 'Keeper access required.'); }
function throttle(string $scope, int $limit, int $seconds): void {
    $now = time(); $bucket = hash('sha256', $scope . ':' . intdiv($now, $seconds));
    $ignore = db()->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? 'INSERT IGNORE' : 'INSERT OR IGNORE';
    sql("$ignore INTO rate_limits(bucket,hits,expires_at) VALUES (?,0,?)", [$bucket, (intdiv($now,$seconds)+1)*$seconds]);
    sql('UPDATE rate_limits SET hits=hits+1 WHERE bucket=?', [$bucket]);
    if ((int)row('SELECT hits FROM rate_limits WHERE bucket=?',[$bucket])['hits'] > $limit) fail(429, 'Please wait before trying again.');
}
function addPost(array $user, int $topicId, string $body, ?int $parent, string $key): int {
    return atomic(function() use($user,$topicId,$body,$parent,$key) {
        $topic = row('SELECT * FROM topics WHERE id=?' . lockSql(), [$topicId]);
        if (!$topic) fail(404, 'Topic not found.');
        $old = row('SELECT id,topic_id,body,parent_id FROM posts WHERE request_key=?',[$key]);
        if ($old) {
            if ((int)$old['topic_id'] !== $topicId || $old['body'] !== $body || ($old['parent_id'] === null ? null : (int)$old['parent_id']) !== $parent) fail(409,'Request key already used for different content.');
            return (int)$old['id'];
        }
        if ((int)$topic['locked']) fail(409, 'This topic is locked.');
        if ($parent && !row('SELECT id FROM posts WHERE id=? AND topic_id=? AND hidden=0',[$parent,$topicId])) fail(422,'Reply target is not in this topic.');
        sql('INSERT INTO posts(topic_id,author_id,parent_id,body,created_at,request_key) VALUES (?,?,?,?,?,?)',[$topicId,$user['id'],$parent,$body,time(),$key]);
        $id=(int)db()->lastInsertId();
        sql('UPDATE topics SET updated_at=? WHERE id=?',[time(),$topicId]);
        return $id;
    });
}
function addMemory(int $bot, int $postId, string $summary): int {
    $post=row('SELECT * FROM posts WHERE id=? AND hidden=0',[$postId]);
    if (!$post) fail(422,'Memory needs a visible source post.');
    if (!row("SELECT id FROM users WHERE id=? AND kind='bot'",[$bot])) fail(422,'Only bots have memory notebooks.');
    $old=row('SELECT id FROM memories WHERE bot_id=? AND source_post_id=?',[$bot,$postId]);
    if ($old) return (int)$old['id'];
    sql('INSERT INTO memories(bot_id,topic_id,source_post_id,summary,created_at) VALUES (?,?,?,?,?)',[$bot,$post['topic_id'],$postId,$summary,time()]);
    return (int)db()->lastInsertId();
}
function queueRound(int $topicId, bool $manual = false): int {
    return atomic(function() use($topicId,$manual) {
        $t=row('SELECT * FROM topics WHERE id=?'.lockSql(),[$topicId]);
        if (!$t || (int)$t['locked'] || (!$manual && (!(int)$t['bots_enabled'] || (int)$t['next_round_at']>time()))) return 0;
        if (row("SELECT id FROM jobs WHERE topic_id=? AND status IN ('pending','running','uncertain','failed')",[$topicId])) return 0;
        $bots=sql("SELECT id FROM users WHERE kind='bot' AND autonomous=1 AND active=1 ORDER BY id")->fetchAll();
        if (!$bots) return 0;
        // Rotate the starting speaker so all enabled characters get a turn.
        $offset=(int)row('SELECT COUNT(*) AS n FROM jobs WHERE topic_id=?',[$topicId])['n'] % count($bots);
        for($i=0;$i<min(3,count($bots));$i++) sql('INSERT INTO jobs(topic_id,bot_id,created_at) VALUES (?,?,?)',[$topicId,$bots[($offset+$i)%count($bots)]['id'],time()]);
        sql('UPDATE topics SET next_round_at=? WHERE id=?',[time()+max(300,(int)cfg()['ai']['round_interval_seconds']),$topicId]);
        return min(3,count($bots));
    });
}
function dispatch(string $action, string $method, array $d): array {
    if ($method === 'GET') {
        if ($action === 'state') {
            $u=viewer();
            return ['version'=>'0.5.0-preview','installed'=>setting('installed')==='1','csrf'=>$_SESSION['csrf'],
                'user'=>$u ? publicUser($u) : null,'boards'=>sql('SELECT * FROM boards ORDER BY id')->fetchAll(),
                'bots'=>sql("SELECT id,handle,kind,persona,autonomous FROM users WHERE kind='bot' AND active=1 ORDER BY id")->fetchAll(),
                'autopilot'=>setting('autopilot')==='1'];
        }
        if ($action === 'topics') {
            $board=idField($d,'board_id');$offset=max(0,min(100000,(int)($d['offset']??0)));
            return ['topics'=>sql("SELECT t.*,u.handle,(SELECT COUNT(*) FROM posts p WHERE p.topic_id=t.id AND p.hidden=0) AS post_count FROM topics t JOIN users u ON u.id=t.author_id WHERE board_id=? ORDER BY updated_at DESC,id DESC LIMIT 30 OFFSET $offset",[$board])->fetchAll()];
        }
        if ($action === 'posts') {
            $id=idField($d,'topic_id');$after=max(0,(int)($d['after']??0));
            $t=row('SELECT t.*,b.name AS board_name FROM topics t JOIN boards b ON b.id=t.board_id WHERE t.id=?',[$id]);
            if (!$t) fail(404,'Topic not found.');
            $posts=sql('SELECT p.id,p.topic_id,p.parent_id,p.body,p.created_at,u.id AS author_id,u.handle,u.kind FROM posts p JOIN users u ON u.id=p.author_id WHERE p.topic_id=? AND p.id>? AND p.hidden=0 ORDER BY p.id LIMIT 101',[$id,$after])->fetchAll();
            return ['topic'=>$t,'more'=>count($posts)>100,'posts'=>array_slice($posts,0,100)];
        }
        if ($action === 'memories') {
            $bot=idField($d,'bot_id');$before=max(1,(int)($d['before']??PHP_INT_MAX));
            return ['memories'=>sql('SELECT m.*,t.title FROM memories m JOIN posts p ON p.id=m.source_post_id JOIN topics t ON t.id=m.topic_id WHERE m.bot_id=? AND m.id<? AND p.hidden=0 ORDER BY m.id DESC LIMIT 50',[$bot,$before])->fetchAll()];
        }
        if ($action === 'admin') {
            secureTransport();$u=viewer();if(!$u) fail(401,'Sign in.');keeper($u);
            return ['jobs'=>sql('SELECT j.*,u.handle,t.title FROM jobs j JOIN users u ON u.id=j.bot_id JOIN topics t ON t.id=j.topic_id ORDER BY j.id DESC LIMIT 30')->fetchAll(),
                'accounts'=>sql('SELECT id,handle,kind,active,autonomous FROM users ORDER BY id')->fetchAll(),
                'calls_today'=>(int)row('SELECT COUNT(*) AS n FROM ai_calls WHERE created_at>=?',[strtotime('today UTC')])['n'],
                'daily_call_limit'=>cfg()['ai']['daily_call_limit']];
        }
        fail(404,'Unknown action.');
    }
    if ($method !== 'POST') fail(405,'Use GET or POST.');
    secureTransport();
    if ($action === 'setup') {
        csrf();throttle('setup:'.($_SERVER['REMOTE_ADDR']??'local'),5,900);
        $secret=cfg()['setup_secret']??'';
        if (strlen($secret)<32 || str_contains($secret,'REPLACE_') || !hash_equals($secret,(string)($d['secret']??''))) fail(403,'Invalid setup secret.');
        $handle=textField($d,'handle',2,32);$password=textField($d,'password',12,72);
        if (!preg_match('/^[A-Za-z0-9_-]{2,32}$/',$handle)) fail(422,'Use letters, digits, underscores or hyphens for handles.');
        atomic(function() use($handle,$password) {
            $s=row("SELECT value FROM settings WHERE name='installed'".lockSql());
            if (!$s || $s['value']!=='0') fail(409,'Setup is already complete.');
            sql("INSERT INTO users(handle,kind,is_admin,password_hash,persona,created_at) VALUES (?,'human',1,?,'Keeper of the Rusty Flagon',?)",[$handle,password_hash($password,PASSWORD_DEFAULT),time()]);
            foreach (['Mara'=>'Welcoming host; curious, observant, keeps discussion moving.','Codey'=>'Practical builder; asks how things work and offers concrete examples.','Percy'=>'Thoughtful, candid strategist with dry humour.','Aldric'=>'Reflective old wizard, fond of difficult questions.','Nix'=>'Sceptical and quick-witted; challenges easy answers.'] as $name=>$persona)
                sql("INSERT INTO users(handle,kind,persona,autonomous,created_at) VALUES (?,'bot',?,1,?)",[$name,$persona,time()]);
            sql("INSERT INTO boards(name,description) VALUES ('The common room','Conversations between humans and AI regulars.'),('The workshop','Experiments, ideas and things worth building.')");
            sql("UPDATE settings SET value='1' WHERE name='installed'");
        });
        return ['ok'=>true];
    }
    if ($action === 'login') {
        csrf();throttle('login:'.($_SERVER['REMOTE_ADDR']??'local'),10,900);
        $u=row("SELECT * FROM users WHERE handle=? AND kind='human' AND active=1",[textField($d,'handle',2,32)]);
        $valid=password_verify(textField($d,'password',1,72),$u['password_hash']??'$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi.');
        if (!$u || !$valid) fail(401,'Handle or password not recognised.');
        session_regenerate_id(true);$_SESSION['uid']=(int)$u['id'];$_SESSION['until']=time()+28800;$_SESSION['csrf']=bin2hex(random_bytes(24));
        return ['ok'=>true];
    }
    $u=actor();
    throttle('actor:'.$u['id'],(int)$u['is_admin']?120:20,3600);
    if ($action === 'logout') { $_SESSION=[];session_destroy();return ['ok'=>true]; }
    if ($action === 'topic') {
        $title=textField($d,'title',3,160);$body=textField($d,'body');$board=idField($d,'board_id');
        if (!row('SELECT id FROM boards WHERE id=?',[$board])) fail(422,'Board not found.');
        $id=atomic(function() use($u,$title,$body,$board) {
            sql('INSERT INTO topics(board_id,author_id,title,created_at,updated_at) VALUES (?,?,?,?,?)',[$board,$u['id'],$title,time(),time()]);
            $id=(int)db()->lastInsertId();addPost($u,$id,$body,null,'topic:'.bin2hex(random_bytes(16)));return $id;
        });
        return ['topic_id'=>$id];
    }
    if ($action === 'post') {
        $key=textField($d,'request_key',8,64);if(!preg_match('/^[a-zA-Z0-9_-]+$/',$key)) fail(422,'Invalid request key.');
        $id=addPost($u,idField($d,'topic_id'),textField($d,'body'),empty($d['parent_id'])?null:idField($d,'parent_id'),'user:'.$u['id'].':'.$key);
        return ['post_id'=>$id];
    }
    if ($action === 'memory') {
        if ($u['kind']!=='bot') fail(403,'Bot key required.');
        return ['memory_id'=>atomic(fn()=>addMemory((int)$u['id'],idField($d,'source_post_id'),textField($d,'summary',8,800)))];
    }
    keeper($u);
    if ($action === 'account') {
        $handle=textField($d,'handle',2,32);if(!preg_match('/^[A-Za-z0-9_-]{2,32}$/',$handle)) fail(422,'Invalid handle.');
        $kind=($d['kind']??'')==='bot'?'bot':'human';
        $persona=$kind==='bot'?textField($d,'persona',8,2000):'Forum member';
        $hash=$kind==='human'?password_hash(textField($d,'password',12,72),PASSWORD_DEFAULT):null;
        $key=$kind==='bot'?bin2hex(random_bytes(32)):null;
        if(row('SELECT id FROM users WHERE handle=?',[$handle]))fail(409,'Handle already exists.');
        sql('INSERT INTO users(handle,kind,password_hash,api_hash,persona,created_at) VALUES (?,?,?,?,?,?)',[$handle,$kind,$hash,$key?hash('sha256',$key):null,$persona,time()]);
        return ['id'=>(int)db()->lastInsertId(),'api_key'=>$key];
    }
    if ($action === 'rotate_key') {
        $id=idField($d,'bot_id');if(!row("SELECT id FROM users WHERE id=? AND kind='bot'",[$id])) fail(404,'Bot not found.');
        $key=bin2hex(random_bytes(32));sql('UPDATE users SET api_hash=? WHERE id=?',[hash('sha256',$key),$id]);return ['api_key'=>$key];
    }
    if ($action === 'account_status') {
        $id=idField($d,'user_id');if($id===(int)$u['id']) fail(422,'You cannot disable your own account.');
        sql('UPDATE users SET active=?,autonomous=? WHERE id=?',[(int)!empty($d['active']),(int)!empty($d['autonomous']),$id]);return ['ok'=>true];
    }
    if ($action === 'topic_status') {
        sql('UPDATE topics SET locked=?,bots_enabled=? WHERE id=?',[(int)!empty($d['locked']),(int)!empty($d['bots_enabled']),idField($d,'topic_id')]);return ['ok'=>true];
    }
    if ($action === 'hide_post') {
        sql('UPDATE posts SET hidden=1 WHERE id=?',[idField($d,'post_id')]);return ['ok'=>true];
    }
    if ($action === 'forget_memory') {
        sql('DELETE FROM memories WHERE id=?',[idField($d,'memory_id')]);return ['ok'=>true];
    }
    if ($action === 'autopilot') {
        sql("UPDATE settings SET value=? WHERE name='autopilot'",[!empty($d['enabled'])?'1':'0']);return ['ok'=>true];
    }
    if ($action === 'round') return ['queued'=>queueRound(idField($d,'topic_id'),true)];
    if ($action === 'job_action') {
        $id=idField($d,'job_id');$retry=($d['operation']??'')==='retry';
        sql("UPDATE jobs SET status=?,error=NULL WHERE id=? AND status IN ('failed','uncertain')",[$retry?'pending':'cancelled',$id]);return ['ok'=>true];
    }
    fail(404,'Unknown action.');
}
