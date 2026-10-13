<?php

declare(strict_types=1);

// The router behind the stub server the tests start with `php -S`. Every
// request is appended to requests.jsonl in the stub directory, body base64ed
// so an image upload survives the trip, and the answer is whatever
// response.json says: status, content type, extra headers and body. The tests
// write that file before each call.

$directory = getenv("YEETPOST_STUB_DIRECTORY");

$headers = [];

foreach (getallheaders() as $name => $value) {
    $headers[strtolower($name)] = $value;
}

$recorded = [
    "method" => $_SERVER["REQUEST_METHOD"],
    "path" => $_SERVER["REQUEST_URI"],
    "headers" => $headers,
    "body" => base64_encode((string) file_get_contents("php://input")),
];

file_put_contents(
    $directory . "/requests.jsonl",
    json_encode($recorded, JSON_THROW_ON_ERROR) . "\n",
    FILE_APPEND,
);

$response = json_decode((string) file_get_contents($directory . "/response.json"), true, 512, JSON_THROW_ON_ERROR);

http_response_code($response["status"]);
header("content-type: " . $response["contentType"]);

foreach ($response["extraHeaders"] as $name => $value) {
    header($name . ": " . $value);
}

echo $response["body"];
