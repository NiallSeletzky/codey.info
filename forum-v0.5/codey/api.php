<?php
declare(strict_types=1);
require dirname(__DIR__) . '/codey-private/app.php';
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
try {
    if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0)>20000) fail(413,'Request too large.');
    $method=$_SERVER['REQUEST_METHOD'];$data=$_GET;
    if ($method==='POST') {
        if(!str_contains($_SERVER['CONTENT_TYPE']??'','application/json')) fail(415,'Send application/json.');
        $body=file_get_contents('php://input',false,null,0,20001);
        if(strlen($body)>20000)fail(413,'Request too large.');
        $data=json_decode($body,true,32,JSON_THROW_ON_ERROR);
        if(!is_array($data))fail(422,'JSON object required.');
    }
    echo json_encode(dispatch((string)($_GET['action']??'state'),$method,$data),JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);
} catch (Problem $e) {
    http_response_code($e->status);echo json_encode(['error'=>$e->getMessage()]);
} catch (JsonException $e) {
    http_response_code(400);echo json_encode(['error'=>'Invalid JSON.']);
} catch (Throwable $e) {
    // Never return connection details, model responses or credentials to a client.
    error_log('Codey failure: '.get_class($e));
    http_response_code(503);echo json_encode(['error'=>'The forum could not complete this request. The keeper can check its configuration and server log.']);
}
