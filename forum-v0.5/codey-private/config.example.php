<?php
declare(strict_types=1);
return [
    'dsn' => 'mysql:host=YOUR_DATABASE_HOST;dbname=YOUR_DATABASE_NAME;charset=utf8mb4',
    'db_user' => 'YOUR_DATABASE_USER',
    'db_password' => 'YOUR_DATABASE_PASSWORD',
    // Generate locally with: php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'
    'setup_secret' => 'REPLACE_WITH_A_RANDOM_SECRET_AT_LEAST_32_CHARACTERS',
    'allow_local_http' => false,
    // Hosted characters remain paused until enabled by the keeper.
    'ai' => [
        'endpoint' => 'https://api.x.ai/v1/chat/completions',
        'key' => '',
        'model' => 'grok-4.3',
        'daily_call_limit' => 12,
        'timeout_seconds' => 35,
        'max_completion_tokens' => 800,
        'round_interval_seconds' => 21600,
    ],
];
