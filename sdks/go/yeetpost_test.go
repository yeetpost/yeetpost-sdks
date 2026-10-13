package yeetpost

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"testing"
	"time"
)

// The client is exercised against a real http server on a random port, so the
// request it actually puts on the wire (method, path, query, headers, body) is
// what gets asserted. Nothing here reaches the network.

type recordedRequest struct {
	method  string
	url     string
	headers http.Header
	body    string
}

type stubServer struct {
	server *httptest.Server
	// extraHeaders go out with the response, for the request id and rate limit
	// headers. Set them before the call.
	extraHeaders map[string]string
	requests     []recordedRequest
}

func newStubServer(t *testing.T, status int, contentType string, responseBody string) *stubServer {
	stub := &stubServer{extraHeaders: map[string]string{}}

	stub.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestBody, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("the stub server could not read the request body: %v", err)
			return
		}

		stub.requests = append(stub.requests, recordedRequest{
			method:  request.Method,
			url:     request.URL.RequestURI(),
			headers: request.Header.Clone(),
			body:    string(requestBody),
		})

		for name, value := range stub.extraHeaders {
			writer.Header().Set(name, value)
		}

		writer.Header().Set("content-type", contentType)
		writer.WriteHeader(status)
		writer.Write([]byte(responseBody))
	}))

	t.Cleanup(stub.server.Close)

	return stub
}

func newJSONStub(t *testing.T, status int, responseBody string) *stubServer {
	return newStubServer(t, status, "application/json", responseBody)
}

func newClient(stub *stubServer) *Client {
	return New("yp_secret_test", WithBaseURL(stub.server.URL+"/api/v2"))
}

// onlyRequest is the single request a call is expected to have made.
func onlyRequest(t *testing.T, stub *stubServer) recordedRequest {
	t.Helper()

	if len(stub.requests) != 1 {
		t.Fatalf("requests: got %d, want 1", len(stub.requests))
	}

	return stub.requests[0]
}

func stringPointer(value string) *string {
	return &value
}

func intPointer(value int) *int {
	return &value
}

func boolPointer(value bool) *bool {
	return &value
}

func floatPointer(value float64) *float64 {
	return &value
}

func TestListConnectionsSendsTheApiKeyAsTheHeader(t *testing.T) {
	stub := newJSONStub(t, 200, `{"connections":[{"id":"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b","slug":"linkedin","platformId":"linkedin","description":"Alex Doe (LinkedIn)","timezone":"Europe/Helsinki","queueSlots":[{"weekday":1,"time":"09:00"},{"weekday":4,"time":"17:30"}]}]}`)

	response, err := newClient(stub).ListConnections(context.Background(), nil)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "GET" {
		t.Errorf("method: got %q, want %q", request.method, "GET")
	}

	if request.url != "/api/v2/connections" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/connections")
	}

	if request.headers.Get("x-api-key") != "yp_secret_test" {
		t.Errorf("x-api-key: got %q, want %q", request.headers.Get("x-api-key"), "yp_secret_test")
	}

	want := ConnectionsResponse{
		Connections: []Connection{
			{
				ID:          "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
				Slug:        "linkedin",
				PlatformID:  "linkedin",
				Description: "Alex Doe (LinkedIn)",
				Timezone:    "Europe/Helsinki",
				QueueSlots:  []QueueSlot{{Weekday: 1, Time: "09:00"}, {Weekday: 4, Time: "17:30"}},
			},
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestGetConnectionReturnsTheConnectionWithItsQueueSettings(t *testing.T) {
	stub := newJSONStub(t, 200, `{"connection":{"id":"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b","slug":"linkedin","platformId":"linkedin","description":"Alex Doe (LinkedIn)","timezone":"Europe/Helsinki","queueSlots":[{"weekday":1,"time":"09:00"},{"weekday":4,"time":"17:30"}]}}`)

	response, err := newClient(stub).GetConnection(context.Background(), "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "GET" {
		t.Errorf("method: got %q, want %q", request.method, "GET")
	}

	if request.url != "/api/v2/connections/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/connections/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b")
	}

	want := GetConnectionResponse{
		Connection: Connection{
			ID:          "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
			Slug:        "linkedin",
			PlatformID:  "linkedin",
			Description: "Alex Doe (LinkedIn)",
			Timezone:    "Europe/Helsinki",
			QueueSlots:  []QueueSlot{{Weekday: 1, Time: "09:00"}, {Weekday: 4, Time: "17:30"}},
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestUpdateConnectionMovesTheConnectionIntoAProfile(t *testing.T) {
	stub := newJSONStub(t, 200, `{"connection":{"id":"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b","slug":"linkedin","platformId":"linkedin","description":"Alex Doe (LinkedIn)","profileId":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","timezone":"Europe/Helsinki","queueSlots":[]}}`)

	profileID := "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b"

	response, err := newClient(stub).UpdateConnection(
		context.Background(),
		"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
		UpdateConnectionParams{ProfileID: &profileID},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/connections/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b"

	if request.method != "PATCH" {
		t.Errorf("method: got %q, want %q", request.method, "PATCH")
	}

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	wantBody := `{"profileId":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}

	want := UpdateConnectionResponse{
		Connection: Connection{
			ID:          "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
			Slug:        "linkedin",
			PlatformID:  "linkedin",
			Description: "Alex Doe (LinkedIn)",
			ProfileID:   &profileID,
			Timezone:    "Europe/Helsinki",
			QueueSlots:  []QueueSlot{},
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestUpdateConnectionSendsAnExplicitNullToMoveItBackOut(t *testing.T) {
	stub := newJSONStub(t, 200, `{"connection":{"id":"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b","slug":"linkedin","platformId":"linkedin","description":"Alex Doe (LinkedIn)","profileId":null,"timezone":"UTC","queueSlots":[]}}`)

	response, err := newClient(stub).UpdateConnection(
		context.Background(),
		"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
		UpdateConnectionParams{},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"profileId":null}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}

	if response.Connection.ProfileID != nil {
		t.Errorf("profileId: got %v, want nil", response.Connection.ProfileID)
	}
}

func TestMovingIntoAProfileThatHoldsTheAccountIsAnApiError(t *testing.T) {
	stub := newJSONStub(t, 409, `{"error":"connection_conflict","message":"That profile already holds a connection to this account."}`)

	profileID := "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b"

	_, err := newClient(stub).UpdateConnection(
		context.Background(),
		"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
		UpdateConnectionParams{ProfileID: &profileID},
	)

	var apiError *APIError

	if !errors.As(err, &apiError) {
		t.Fatalf("err: got %v, want an *APIError", err)
	}

	if apiError.StatusCode != 409 {
		t.Errorf("status: got %d, want %d", apiError.StatusCode, 409)
	}

	if apiError.Code != "connection_conflict" {
		t.Errorf("code: got %q, want %q", apiError.Code, "connection_conflict")
	}
}

func TestListConnectionQueueReturnsThePostsWaitingInIt(t *testing.T) {
	stub := newJSONStub(t, 200, `{"queue":[{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","text":"shipped the new api docs today","scheduledFor":"2026-09-07T06:00:00.000Z","mediaCount":1}]}`)

	response, err := newClient(stub).ListConnectionQueue(context.Background(), "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/connections/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b/queue"

	if request.method != "GET" {
		t.Errorf("method: got %q, want %q", request.method, "GET")
	}

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	want := GetConnectionQueueResponse{
		Queue: []QueuedPost{
			{
				ID:           "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
				Text:         "shipped the new api docs today",
				ScheduledFor: "2026-09-07T06:00:00.000Z",
				MediaCount:   1,
			},
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestUpdateConnectionQueuePatchesTheSlotsAndTheTimezone(t *testing.T) {
	stub := newJSONStub(t, 200, `{"connection":{"id":"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b","slug":"linkedin","timezone":"Europe/Helsinki","queueSlots":[{"weekday":1,"time":"09:00"},{"weekday":4,"time":"17:30"}]}}`)

	response, err := newClient(stub).UpdateConnectionQueue(
		context.Background(),
		"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
		UpdateConnectionQueueParams{
			Slots:    &[]QueueSlot{{Weekday: 1, Time: "09:00"}, {Weekday: 4, Time: "17:30"}},
			Timezone: "Europe/Helsinki",
		},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/connections/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b/queue"

	if request.method != "PATCH" {
		t.Errorf("method: got %q, want %q", request.method, "PATCH")
	}

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	if request.headers.Get("content-type") != "application/json" {
		t.Errorf("content-type: got %q, want %q", request.headers.Get("content-type"), "application/json")
	}

	wantBody := `{"slots":[{"weekday":1,"time":"09:00"},{"weekday":4,"time":"17:30"}],"timezone":"Europe/Helsinki"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}

	want := UpdateConnectionQueueResponse{}
	want.Connection.ID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b"
	want.Connection.Slug = "linkedin"
	want.Connection.Timezone = "Europe/Helsinki"
	want.Connection.QueueSlots = []QueueSlot{{Weekday: 1, Time: "09:00"}, {Weekday: 4, Time: "17:30"}}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestUpdateConnectionQueueSendsOnlyTheTimezoneWhenThatIsAllItWasGiven(t *testing.T) {
	stub := newJSONStub(t, 200, `{"connection":{"id":"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b","slug":"linkedin","timezone":"UTC","queueSlots":[]}}`)

	_, err := newClient(stub).UpdateConnectionQueue(
		context.Background(),
		"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
		UpdateConnectionQueueParams{Timezone: "UTC"},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"timezone":"UTC"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestUpdateConnectionQueueSendsAnEmptySlotListToClearTheSlots(t *testing.T) {
	stub := newJSONStub(t, 200, `{"connection":{"id":"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b","slug":"linkedin","timezone":"Europe/Helsinki","queueSlots":[]}}`)

	_, err := newClient(stub).UpdateConnectionQueue(
		context.Background(),
		"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
		UpdateConnectionQueueParams{Slots: &[]QueueSlot{}},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"slots":[]}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestListConnectionsNarrowsToOneProfile(t *testing.T) {
	stub := newJSONStub(t, 200, `{"connections":[{"id":"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b","slug":"acme_linkedin","platformId":"linkedin","description":"Acme Coffee (LinkedIn)","profileId":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","timezone":"UTC","queueSlots":[]}]}`)

	response, err := newClient(stub).ListConnections(context.Background(), &ListConnectionsParams{
		ProfileID: "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/connections?profileId=b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b"

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	want := ConnectionsResponse{
		Connections: []Connection{
			{
				ID:          "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
				Slug:        "acme_linkedin",
				PlatformID:  "linkedin",
				Description: "Acme Coffee (LinkedIn)",
				ProfileID:   stringPointer("b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b"),
				Timezone:    "UTC",
				QueueSlots:  []QueueSlot{},
			},
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestGetConnectionReadsItsStatusAndLoginExpiresAt(t *testing.T) {
	stub := newJSONStub(t, 200, `{"connection":{"id":"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b","slug":"linkedin","platformId":"linkedin","description":"Alex Doe (LinkedIn)","timezone":"Europe/Helsinki","queueSlots":[],"status":"expiring","loginExpiresAt":"2026-09-20T00:00:00.000Z"}}`)

	response, err := newClient(stub).GetConnection(context.Background(), "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	want := GetConnectionResponse{
		Connection: Connection{
			ID:             "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
			Slug:           "linkedin",
			PlatformID:     "linkedin",
			Description:    "Alex Doe (LinkedIn)",
			Timezone:       "Europe/Helsinki",
			QueueSlots:     []QueueSlot{},
			Status:         "expiring",
			LoginExpiresAt: stringPointer("2026-09-20T00:00:00.000Z"),
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestDeleteConnectionSendsADelete(t *testing.T) {
	stub := newJSONStub(t, 200, `{"id":"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b","deleted":true}`)

	response, err := newClient(stub).DeleteConnection(context.Background(), "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "DELETE" {
		t.Errorf("method: got %q, want %q", request.method, "DELETE")
	}

	if request.url != "/api/v2/connections/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/connections/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b")
	}

	want := DeleteConnectionResponse{ID: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b", Deleted: true}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestCreateProfileSendsTheNameAndTheExternalId(t *testing.T) {
	stub := newJSONStub(t, 200, `{"profile":{"id":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","name":"Acme Coffee","externalId":"cus_4821","createdAt":"2026-08-29T09:24:11.412Z"}}`)

	response, err := newClient(stub).CreateProfile(context.Background(), CreateProfileParams{
		Name:       "Acme Coffee",
		ExternalID: "cus_4821",
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "POST" {
		t.Errorf("method: got %q, want %q", request.method, "POST")
	}

	if request.url != "/api/v2/profiles" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/profiles")
	}

	if request.headers.Get("content-type") != "application/json" {
		t.Errorf("content-type: got %q, want %q", request.headers.Get("content-type"), "application/json")
	}

	wantBody := `{"name":"Acme Coffee","externalId":"cus_4821"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}

	want := CreateProfileResponse{
		Profile: Profile{
			ID:         "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
			Name:       "Acme Coffee",
			ExternalID: stringPointer("cus_4821"),
			CreatedAt:  "2026-08-29T09:24:11.412Z",
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestCreateProfileLeavesOutAnExternalIdItWasNotGiven(t *testing.T) {
	stub := newJSONStub(t, 200, `{"profile":{"id":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","name":"Acme Coffee","externalId":null,"createdAt":"2026-08-29T09:24:11.412Z"}}`)

	response, err := newClient(stub).CreateProfile(context.Background(), CreateProfileParams{Name: "Acme Coffee"})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"name":"Acme Coffee"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}

	if response.Profile.ExternalID != nil {
		t.Errorf("externalId: got %v, want nil", *response.Profile.ExternalID)
	}
}

func TestListProfilesPutsItsPagingInTheQueryString(t *testing.T) {
	stub := newJSONStub(t, 200, `{"profiles":[{"id":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","name":"Acme Coffee","externalId":"cus_4821","createdAt":"2026-08-29T09:24:11.412Z"}],"limit":10,"offset":20}`)

	response, err := newClient(stub).ListProfiles(context.Background(), &ListProfilesParams{Limit: 10, Offset: 20})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "GET" {
		t.Errorf("method: got %q, want %q", request.method, "GET")
	}

	if request.url != "/api/v2/profiles?limit=10&offset=20" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/profiles?limit=10&offset=20")
	}

	want := GetProfilesResponse{
		Profiles: []Profile{
			{
				ID:         "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
				Name:       "Acme Coffee",
				ExternalID: stringPointer("cus_4821"),
				CreatedAt:  "2026-08-29T09:24:11.412Z",
			},
		},
		Limit:  10,
		Offset: 20,
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestListProfilesSendsNoQueryStringWithoutPaging(t *testing.T) {
	stub := newJSONStub(t, 200, `{"profiles":[],"limit":25,"offset":0}`)

	_, err := newClient(stub).ListProfiles(context.Background(), nil)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.url != "/api/v2/profiles" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/profiles")
	}
}

func TestGetProfileReturnsTheProfile(t *testing.T) {
	stub := newJSONStub(t, 200, `{"profile":{"id":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","name":"Acme Coffee","externalId":"cus_4821","createdAt":"2026-08-29T09:24:11.412Z"}}`)

	response, err := newClient(stub).GetProfile(context.Background(), "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/profiles/b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b"

	if request.method != "GET" {
		t.Errorf("method: got %q, want %q", request.method, "GET")
	}

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	if response.Profile.Name != "Acme Coffee" {
		t.Errorf("name: got %q, want %q", response.Profile.Name, "Acme Coffee")
	}
}

func TestUpdateProfilePatchesOnlyWhatItWasGiven(t *testing.T) {
	stub := newJSONStub(t, 200, `{"profile":{"id":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","name":"Acme Coffee Oy","externalId":"cus_4821","createdAt":"2026-08-29T09:24:11.412Z"}}`)

	response, err := newClient(stub).UpdateProfile(
		context.Background(),
		"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		UpdateProfileParams{Name: "Acme Coffee Oy"},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/profiles/b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b"

	if request.method != "PATCH" {
		t.Errorf("method: got %q, want %q", request.method, "PATCH")
	}

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	wantBody := `{"name":"Acme Coffee Oy"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}

	if response.Profile.Name != "Acme Coffee Oy" {
		t.Errorf("name: got %q, want %q", response.Profile.Name, "Acme Coffee Oy")
	}
}

func TestUpdateProfileSendsTheExternalIdAsAString(t *testing.T) {
	stub := newJSONStub(t, 200, `{"profile":{"id":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","name":"Acme Coffee","externalId":"cus_9900","createdAt":"2026-08-29T09:24:11.412Z"}}`)

	_, err := newClient(stub).UpdateProfile(
		context.Background(),
		"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		UpdateProfileParams{ExternalID: stringPointer("cus_9900")},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"externalId":"cus_9900"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestUpdateProfileSendsAnExplicitNullToClearTheExternalId(t *testing.T) {
	stub := newJSONStub(t, 200, `{"profile":{"id":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","name":"Acme Coffee","externalId":null,"createdAt":"2026-08-29T09:24:11.412Z"}}`)

	_, err := newClient(stub).UpdateProfile(
		context.Background(),
		"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		UpdateProfileParams{ClearExternalID: true},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	// An explicit null, not an omitted field: the API reads the two differently,
	// and only the null takes the external id off
	wantBody := `{"externalId":null}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestUpdateProfileRefusesBothAnExternalIdAndClearingItBeforeTheCall(t *testing.T) {
	stub := newJSONStub(t, 200, `{}`)

	_, err := newClient(stub).UpdateProfile(
		context.Background(),
		"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		UpdateProfileParams{ExternalID: stringPointer("cus_4821"), ClearExternalID: true},
	)

	if err == nil {
		t.Fatal("err: got nil, want an error")
	}

	if len(stub.requests) != 0 {
		t.Errorf("requests: got %d, want 0", len(stub.requests))
	}
}

func TestUpdateProfileRefusesACallThatNamesNoFieldBeforeTheCall(t *testing.T) {
	stub := newJSONStub(t, 200, `{}`)

	_, err := newClient(stub).UpdateProfile(
		context.Background(),
		"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		UpdateProfileParams{},
	)

	if err == nil {
		t.Fatal("err: got nil, want an error")
	}

	if len(stub.requests) != 0 {
		t.Errorf("requests: got %d, want 0", len(stub.requests))
	}
}

func TestDeleteProfileSaysHowManyConnectionsWentWithIt(t *testing.T) {
	stub := newJSONStub(t, 200, `{"id":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","deleted":true,"removedConnections":2}`)

	response, err := newClient(stub).DeleteProfile(context.Background(), "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/profiles/b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b"

	if request.method != "DELETE" {
		t.Errorf("method: got %q, want %q", request.method, "DELETE")
	}

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	want := DeleteProfileResponse{
		ID:                 "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		Deleted:            true,
		RemovedConnections: 2,
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestAProfileWithAnExternalIdSomebodyElseCarriesIsAnApiError(t *testing.T) {
	stub := newJSONStub(t, 409, `{"error":"profile_external_id_conflict","message":"A profile with this externalId already exists."}`)

	_, err := newClient(stub).CreateProfile(context.Background(), CreateProfileParams{
		Name:       "Acme Coffee",
		ExternalID: "cus_4821",
	})

	var apiError *APIError

	if !errors.As(err, &apiError) {
		t.Fatalf("err: got %v, want an *APIError", err)
	}

	if apiError.StatusCode != 409 {
		t.Errorf("status: got %d, want %d", apiError.StatusCode, 409)
	}

	if apiError.Code != "profile_external_id_conflict" {
		t.Errorf("code: got %q, want %q", apiError.Code, "profile_external_id_conflict")
	}
}

func TestCreateProfileKeySendsTheNameTypeAndAllowlist(t *testing.T) {
	stub := newJSONStub(t, 201, `{"key":{"id":"9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31","name":"Acme integration","type":"live","prefix":"yp_secret_4f9a2c","profileId":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","redirectAllowlist":["https://acme.example.com"],"createdAt":"2026-08-30T09:24:11.412Z","lastUsedAt":null,"revokedAt":null},"secret":"yp_secret_4f9a2c8e"}`)

	response, err := newClient(stub).CreateProfileKey(
		context.Background(),
		"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		CreateProfileKeyParams{
			Name:              "Acme integration",
			Type:              APIKeyTypeLive,
			RedirectAllowlist: []string{"https://acme.example.com"},
		},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/profiles/b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b/keys"

	if request.method != "POST" {
		t.Errorf("method: got %q, want %q", request.method, "POST")
	}

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	if request.headers.Get("content-type") != "application/json" {
		t.Errorf("content-type: got %q, want %q", request.headers.Get("content-type"), "application/json")
	}

	wantBody := `{"name":"Acme integration","type":"live","redirectAllowlist":["https://acme.example.com"]}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}

	want := CreateAPIKeyResponse{
		Key: APIKey{
			ID:                "9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31",
			Name:              "Acme integration",
			Type:              APIKeyTypeLive,
			Prefix:            "yp_secret_4f9a2c",
			ProfileID:         stringPointer("b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b"),
			RedirectAllowlist: []string{"https://acme.example.com"},
			CreatedAt:         "2026-08-30T09:24:11.412Z",
		},
		Secret: "yp_secret_4f9a2c8e",
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestCreateProfileKeyLeavesOutAnAllowlistItWasNotGiven(t *testing.T) {
	stub := newJSONStub(t, 201, `{"key":{"id":"9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31","name":"Acme integration","type":"live","prefix":"yp_secret_4f9a2c","profileId":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","redirectAllowlist":null,"createdAt":"2026-08-30T09:24:11.412Z","lastUsedAt":null,"revokedAt":null},"secret":"yp_secret_4f9a2c8e"}`)

	response, err := newClient(stub).CreateProfileKey(
		context.Background(),
		"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		CreateProfileKeyParams{Name: "Acme integration", Type: APIKeyTypeLive},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"name":"Acme integration","type":"live"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}

	if response.Key.RedirectAllowlist != nil {
		t.Errorf("redirectAllowlist: got %v, want nil", response.Key.RedirectAllowlist)
	}
}

func TestListProfileKeysPutsIncludeRevokedInTheQueryString(t *testing.T) {
	stub := newJSONStub(t, 200, `{"keys":[{"id":"9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31","name":"Acme integration","type":"live","prefix":"yp_secret_4f9a2c","profileId":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","redirectAllowlist":["https://acme.example.com"],"createdAt":"2026-08-30T09:24:11.412Z","lastUsedAt":null,"revokedAt":"2026-08-30T10:00:00.000Z"}],"limit":25,"offset":0}`)

	response, err := newClient(stub).ListProfileKeys(
		context.Background(),
		"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		ListAPIKeysParams{IncludeRevoked: boolPointer(true)},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/profiles/b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b/keys?includeRevoked=true"

	if request.method != "GET" {
		t.Errorf("method: got %q, want %q", request.method, "GET")
	}

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	want := GetAPIKeysResponse{
		Keys: []APIKey{
			{
				ID:                "9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31",
				Name:              "Acme integration",
				Type:              APIKeyTypeLive,
				Prefix:            "yp_secret_4f9a2c",
				ProfileID:         stringPointer("b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b"),
				RedirectAllowlist: []string{"https://acme.example.com"},
				CreatedAt:         "2026-08-30T09:24:11.412Z",
				RevokedAt:         stringPointer("2026-08-30T10:00:00.000Z"),
			},
		},
		Limit:  25,
		Offset: 0,
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestListProfileKeysSendsAnExplicitIncludeRevokedFalse(t *testing.T) {
	stub := newJSONStub(t, 200, `{"keys":[],"limit":25,"offset":0}`)

	_, err := newClient(stub).ListProfileKeys(
		context.Background(),
		"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		ListAPIKeysParams{IncludeRevoked: boolPointer(false)},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/profiles/b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b/keys?includeRevoked=false"

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}
}

func TestListProfileKeysPutsItsPagingInTheQueryString(t *testing.T) {
	stub := newJSONStub(t, 200, `{"keys":[],"limit":10,"offset":20}`)

	response, err := newClient(stub).ListProfileKeys(
		context.Background(),
		"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		ListAPIKeysParams{Limit: 10, Offset: 20},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/profiles/b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b/keys?limit=10&offset=20"

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	if response.Limit != 10 {
		t.Errorf("limit: got %d, want %d", response.Limit, 10)
	}

	if response.Offset != 20 {
		t.Errorf("offset: got %d, want %d", response.Offset, 20)
	}
}

func TestListProfileKeysSendsNoQueryStringWithoutIncludeRevoked(t *testing.T) {
	stub := newJSONStub(t, 200, `{"keys":[],"limit":25,"offset":0}`)

	_, err := newClient(stub).ListProfileKeys(
		context.Background(),
		"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		ListAPIKeysParams{},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/profiles/b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b/keys"

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}
}

func TestAnIDWithASlashIsEscapedIntoOnePathSegment(t *testing.T) {
	stub := newJSONStub(t, 200, `{"id":"acme/key","revoked":true}`)

	_, err := newClient(stub).RevokeKey(context.Background(), "acme/key")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	// The slash is %2F, so the id cannot open a path of its own
	wantURL := "/api/v2/keys/acme%2Fkey"

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}
}

func TestRevokeProfileKeyDeletesTheKeyUnderItsProfile(t *testing.T) {
	stub := newJSONStub(t, 200, `{"id":"9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31","revoked":true}`)

	response, err := newClient(stub).RevokeProfileKey(
		context.Background(),
		"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		"9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31",
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/profiles/b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b/keys/9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31"

	if request.method != "DELETE" {
		t.Errorf("method: got %q, want %q", request.method, "DELETE")
	}

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	want := RevokeAPIKeyResponse{
		ID:      "9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31",
		Revoked: true,
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestListKeysReadsEveryKeyOfTheAccount(t *testing.T) {
	stub := newJSONStub(t, 200, `{"keys":[{"id":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","name":"Server","type":"live","prefix":"yp_secret_1a2b3c","profileId":null,"redirectAllowlist":null,"createdAt":"2026-08-29T09:24:11.412Z","lastUsedAt":"2026-08-30T08:00:00.000Z","revokedAt":null},{"id":"9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31","name":"Acme integration","type":"live","prefix":"yp_secret_4f9a2c","profileId":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","redirectAllowlist":["https://acme.example.com"],"createdAt":"2026-08-30T09:24:11.412Z","lastUsedAt":null,"revokedAt":null}],"limit":25,"offset":0}`)

	response, err := newClient(stub).ListKeys(context.Background(), ListAPIKeysParams{})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "GET" {
		t.Errorf("method: got %q, want %q", request.method, "GET")
	}

	if request.url != "/api/v2/keys" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/keys")
	}

	want := GetAPIKeysResponse{
		Keys: []APIKey{
			{
				ID:         "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
				Name:       "Server",
				Type:       APIKeyTypeLive,
				Prefix:     "yp_secret_1a2b3c",
				CreatedAt:  "2026-08-29T09:24:11.412Z",
				LastUsedAt: stringPointer("2026-08-30T08:00:00.000Z"),
			},
			{
				ID:                "9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31",
				Name:              "Acme integration",
				Type:              APIKeyTypeLive,
				Prefix:            "yp_secret_4f9a2c",
				ProfileID:         stringPointer("b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b"),
				RedirectAllowlist: []string{"https://acme.example.com"},
				CreatedAt:         "2026-08-30T09:24:11.412Z",
			},
		},
		Limit:  25,
		Offset: 0,
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestListKeysPutsIncludeRevokedInTheQueryString(t *testing.T) {
	stub := newJSONStub(t, 200, `{"keys":[],"limit":25,"offset":0}`)

	_, err := newClient(stub).ListKeys(context.Background(), ListAPIKeysParams{IncludeRevoked: boolPointer(true)})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.url != "/api/v2/keys?includeRevoked=true" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/keys?includeRevoked=true")
	}
}

func TestListKeysPutsItsPagingInTheQueryString(t *testing.T) {
	stub := newJSONStub(t, 200, `{"keys":[],"limit":50,"offset":100}`)

	response, err := newClient(stub).ListKeys(context.Background(), ListAPIKeysParams{Limit: 50, Offset: 100})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.url != "/api/v2/keys?limit=50&offset=100" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/keys?limit=50&offset=100")
	}

	if response.Limit != 50 {
		t.Errorf("limit: got %d, want %d", response.Limit, 50)
	}

	if response.Offset != 100 {
		t.Errorf("offset: got %d, want %d", response.Offset, 100)
	}
}

func TestRevokeKeyRevokesAnyKeyOfTheAccountByID(t *testing.T) {
	stub := newJSONStub(t, 200, `{"id":"9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31","revoked":true}`)

	response, err := newClient(stub).RevokeKey(context.Background(), "9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/keys/9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31"

	if request.method != "DELETE" {
		t.Errorf("method: got %q, want %q", request.method, "DELETE")
	}

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	want := RevokeAPIKeyResponse{
		ID:      "9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31",
		Revoked: true,
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestMintingAKeyWithAKeyScopedToAProfileIsAnApiError(t *testing.T) {
	// Word for word what the API answers a scoped key that tries to manage
	// keys, so the stub is the real refusal rather than an approximation of one
	stub := newJSONStub(t, 403, `{"error":"forbidden","message":"This API key is scoped to profile b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b, which cannot manage API keys. Use an unscoped key for that."}`)

	_, err := newClient(stub).CreateProfileKey(
		context.Background(),
		"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		CreateProfileKeyParams{Name: "Acme integration", Type: APIKeyTypeLive},
	)

	var apiError *APIError

	if !errors.As(err, &apiError) {
		t.Fatalf("err: got %v, want an *APIError", err)
	}

	if apiError.StatusCode != 403 {
		t.Errorf("status: got %d, want %d", apiError.StatusCode, 403)
	}

	if apiError.Code != "forbidden" {
		t.Errorf("code: got %q, want %q", apiError.Code, "forbidden")
	}

	wantMessage := "This API key is scoped to profile b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b, which cannot manage API keys. Use an unscoped key for that."

	if apiError.Message != wantMessage {
		t.Errorf("message: got %q, want %q", apiError.Message, wantMessage)
	}
}

func TestCreateConnectURLPostsThePlatformAndTheRedirectURL(t *testing.T) {
	stub := newJSONStub(t, 200, `{"url":"https://yeetpost.com/connect/8Qm2rXk9vT1sB4nE6yPzL0aJdHcWfUgR","expiresAt":"2026-08-29T09:39:11.412Z","connectSessionId":"7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f"}`)

	response, err := newClient(stub).CreateConnectURL(
		context.Background(),
		"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		CreateConnectURLParams{
			Platform:    ConnectPlatformLinkedIn,
			RedirectURL: "https://acme.example.com/settings/social",
		},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/profiles/b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b/connect"

	if request.method != "POST" {
		t.Errorf("method: got %q, want %q", request.method, "POST")
	}

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	wantBody := `{"platform":"linkedin","redirectUrl":"https://acme.example.com/settings/social"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}

	want := CreateConnectSessionResponse{
		URL:              "https://yeetpost.com/connect/8Qm2rXk9vT1sB4nE6yPzL0aJdHcWfUgR",
		ExpiresAt:        "2026-08-29T09:39:11.412Z",
		ConnectSessionID: "7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f",
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestCreateConnectURLOpensALinkForAMetaPlatform(t *testing.T) {
	stub := newJSONStub(t, 200, `{"url":"https://yeetpost.com/connect/8Qm2rXk9vT1sB4nE6yPzL0aJdHcWfUgR","expiresAt":"2026-08-29T09:39:11.412Z","connectSessionId":"7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f"}`)

	_, err := newClient(stub).CreateConnectURL(
		context.Background(),
		"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		CreateConnectURLParams{
			Platform:    ConnectPlatformThreads,
			RedirectURL: "https://acme.example.com/settings/social",
		},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"platform":"threads","redirectUrl":"https://acme.example.com/settings/social"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestCreateConnectURLLeavesThePlatformOutForAPicker(t *testing.T) {
	stub := newJSONStub(t, 200, `{"url":"https://yeetpost.com/connect/8Qm2rXk9vT1sB4nE6yPzL0aJdHcWfUgR","expiresAt":"2026-08-29T09:39:11.412Z","connectSessionId":"7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f"}`)

	_, err := newClient(stub).CreateConnectURL(
		context.Background(),
		"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		CreateConnectURLParams{
			RedirectURL: "https://acme.example.com/settings/social",
			Headless:    true,
		},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"redirectUrl":"https://acme.example.com/settings/social","headless":true}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestGetConnectSessionReadsHowALinkEnded(t *testing.T) {
	stub := newJSONStub(t, 200, `{"connectSession":{"id":"7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f","profileId":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","platform":"linkedin","status":"connected","connectionId":"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b","error":null,"redirectUrl":"https://acme.example.com/settings/social","headless":false,"expiresAt":"2026-08-29T09:39:11.412Z","createdAt":"2026-08-29T09:24:11.412Z"}}`)

	response, err := newClient(stub).GetConnectSession(context.Background(), "7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/connect-sessions/7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f"

	if request.method != "GET" {
		t.Errorf("method: got %q, want %q", request.method, "GET")
	}

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	linkedin := ConnectPlatformLinkedIn

	want := ConnectSession{
		ID:           "7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f",
		ProfileID:    "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		Platform:     &linkedin,
		Status:       ConnectSessionStatusConnected,
		ConnectionID: stringPointer("3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b"),
		Error:        nil,
		RedirectURL:  "https://acme.example.com/settings/social",
		Headless:     false,
		ExpiresAt:    "2026-08-29T09:39:11.412Z",
		CreatedAt:    "2026-08-29T09:24:11.412Z",
	}

	if !reflect.DeepEqual(response.ConnectSession, want) {
		t.Errorf("connectSession: got %+v, want %+v", response.ConnectSession, want)
	}
}

func TestParseConnectRedirectReadsTheQueryAConnectedCustomerCameBackOn(t *testing.T) {
	query, err := url.ParseQuery("connectSessionId=7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f&connectionId=3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b&profileId=b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b&slug=acme_linkedin&platform=linkedin")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	want := ConnectRedirect{
		ConnectSessionID: "7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f",
		ConnectionID:     "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
		ProfileID:        "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
		Slug:             "acme_linkedin",
		Platform:         "linkedin",
	}

	if got := ParseConnectRedirect(query); got != want {
		t.Errorf("redirect: got %+v, want %+v", got, want)
	}
}

func TestParseConnectRedirectReadsACancelledRedirect(t *testing.T) {
	query, err := url.ParseQuery("connectSessionId=7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f&error=cancelled")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	// No connection was made, so the connection fields stay empty
	want := ConnectRedirect{
		ConnectSessionID: "7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f",
		Error:            "cancelled",
	}

	if got := ParseConnectRedirect(query); got != want {
		t.Errorf("redirect: got %+v, want %+v", got, want)
	}
}

func TestParseConnectRedirectLeavesTheSessionIDEmptyOnAQueryThatIsNotOurs(t *testing.T) {
	query, err := url.ParseQuery("utm_source=newsletter")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	if got := ParseConnectRedirect(query); got != (ConnectRedirect{}) {
		t.Errorf("redirect: got %+v, want an empty one", got)
	}
}

func TestPostToConnectionSendsTheTextAsTheBody(t *testing.T) {
	stub := newJSONStub(t, 200, `{"platform":"linkedin","link":"https://www.linkedin.com/feed/update/urn:li:share:1234567890"}`)

	response, err := newClient(stub).PostToConnection(
		context.Background(),
		"linkedin",
		"shipped the new api docs today",
		PostToConnectionParams{},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "POST" {
		t.Errorf("method: got %q, want %q", request.method, "POST")
	}

	if request.url != "/api/v2/post/linkedin" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/post/linkedin")
	}

	if request.headers.Get("content-type") != "text/plain" {
		t.Errorf("content-type: got %q, want %q", request.headers.Get("content-type"), "text/plain")
	}

	if request.body != "shipped the new api docs today" {
		t.Errorf("body: got %q, want %q", request.body, "shipped the new api docs today")
	}

	want := LegacyPostResponse{
		Platform: "linkedin",
		Link:     "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestPostToConnectionReadsARedditLinkBack(t *testing.T) {
	stub := newJSONStub(t, 200, `{"platform":"reddit","link":"https://www.reddit.com/r/yeetpost/comments/1abc2de/shipped_the_new_api_docs_today/"}`)

	response, err := newClient(stub).PostToConnection(
		context.Background(),
		"reddit",
		"shipped the new api docs today",
		PostToConnectionParams{},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.url != "/api/v2/post/reddit" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/post/reddit")
	}

	want := LegacyPostResponse{
		Platform: "reddit",
		Link:     "https://www.reddit.com/r/yeetpost/comments/1abc2de/shipped_the_new_api_docs_today/",
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestPostToConnectionSchedulesAndEscapesTheSlug(t *testing.T) {
	stub := newJSONStub(t, 200, `{"scheduled":true,"scheduled_for":"2026-09-15T15:00:00.000Z"}`)

	response, err := newClient(stub).PostToConnection(
		context.Background(),
		"alex/doe",
		"scheduled from a real integration",
		PostToConnectionParams{ScheduledFor: "2026-09-15T15:00:00Z"},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/post/alex%2Fdoe?scheduled_for=2026-09-15T15%3A00%3A00Z"

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	want := LegacyPostResponse{Scheduled: true, ScheduledFor: "2026-09-15T15:00:00.000Z"}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestCreatePostsSendsTheBodyAndTheIdempotencyKey(t *testing.T) {
	stub := newJSONStub(t, 200, `{"results":[
		{"connectionSlug":"linkedin","status":"sent","postId":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","url":"https://www.linkedin.com/feed/update/urn:li:share:1234567890","scheduledFor":null,"threadCount":0,"hasFirstComment":false,"error":null},
		{"connectionSlug":"x","status":"failed","postId":"0b7e4a52-9f0c-4a1c-8b3a-6d2f5b1c0e44","url":null,"scheduledFor":null,"threadCount":0,"hasFirstComment":false,"error":{"code":"platform_rejected","message":"X: duplicate post was detected"}}
	]}`)

	response, err := newClient(stub).CreatePosts(context.Background(), CreatePostsParams{
		Text:            "shipped the new api docs today",
		ConnectionSlugs: []string{"linkedin", "x"},
		IdempotencyKey:  "release-v2.4.0-announcement",
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "POST" {
		t.Errorf("method: got %q, want %q", request.method, "POST")
	}

	if request.url != "/api/v2/posts" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/posts")
	}

	if request.headers.Get("content-type") != "application/json" {
		t.Errorf("content-type: got %q, want %q", request.headers.Get("content-type"), "application/json")
	}

	if request.headers.Get("idempotency-key") != "release-v2.4.0-announcement" {
		t.Errorf("idempotency-key: got %q, want %q", request.headers.Get("idempotency-key"), "release-v2.4.0-announcement")
	}

	wantBody := `{"text":"shipped the new api docs today","connectionSlugs":["linkedin","x"]}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}

	want := CreatePostsResponse{
		Results: Results{
			{
				ConnectionSlug:  "linkedin",
				Status:          PostStatusSent,
				PostID:          stringPointer("6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10"),
				URL:             stringPointer("https://www.linkedin.com/feed/update/urn:li:share:1234567890"),
				ScheduledFor:    nil,
				ThreadCount:     0,
				HasFirstComment: false,
				Error:           nil,
			},
			{
				ConnectionSlug:  "x",
				Status:          PostStatusFailed,
				PostID:          stringPointer("0b7e4a52-9f0c-4a1c-8b3a-6d2f5b1c0e44"),
				URL:             nil,
				ScheduledFor:    nil,
				ThreadCount:     0,
				HasFirstComment: false,
				Error:           &PostError{Code: "platform_rejected", Message: "X: duplicate post was detected"},
			},
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

// Word for word what the API attaches to a send while the account is over the
// free connection limit and the grace window is still open.
const graceWarning = "This account has 4 connected accounts, over the free limit of 3. Subscribe or disconnect down to 3 by 2026-09-18 to keep posting."

func TestCreatePostsReadsTheWarningInsideTheGraceWindow(t *testing.T) {
	stub := newJSONStub(t, 200, `{"results":[{"connectionSlug":"linkedin","status":"sent","postId":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","url":"https://www.linkedin.com/feed/update/urn:li:share:1234567890","scheduledFor":null,"threadCount":0,"hasFirstComment":false,"warning":"`+graceWarning+`","error":null}]}`)

	response, err := newClient(stub).CreatePosts(context.Background(), CreatePostsParams{
		Text:            "shipped the new api docs today",
		ConnectionSlugs: []string{"linkedin"},
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	want := CreatePostsResponse{
		Results: Results{
			{
				ConnectionSlug:  "linkedin",
				Status:          PostStatusSent,
				PostID:          stringPointer("6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10"),
				URL:             stringPointer("https://www.linkedin.com/feed/update/urn:li:share:1234567890"),
				ScheduledFor:    nil,
				ThreadCount:     0,
				HasFirstComment: false,
				Warning:         graceWarning,
				Error:           nil,
			},
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestCreatePostsReadsAConnectionLimitRefusalAsAFailedItem(t *testing.T) {
	stub := newJSONStub(t, 200, `{"results":[{"connectionSlug":"linkedin","status":"failed","postId":null,"url":null,"scheduledFor":null,"threadCount":0,"hasFirstComment":false,"error":{"code":"connection_limit_exceeded","message":"This account has 4 connected accounts, over the free limit of 3. Subscribe or disconnect down to 3 to keep posting."}}]}`)

	response, err := newClient(stub).CreatePosts(context.Background(), CreatePostsParams{
		Text:            "shipped the new api docs today",
		ConnectionSlugs: []string{"linkedin"},
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	want := CreatePostsResponse{
		Results: Results{
			{
				ConnectionSlug:  "linkedin",
				Status:          PostStatusFailed,
				PostID:          nil,
				URL:             nil,
				ScheduledFor:    nil,
				ThreadCount:     0,
				HasFirstComment: false,
				Warning:         "",
				Error: &PostError{
					Code:    "connection_limit_exceeded",
					Message: "This account has 4 connected accounts, over the free limit of 3. Subscribe or disconnect down to 3 to keep posting.",
				},
			},
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestCreatePostsSendsTheProfileItGoesOutFor(t *testing.T) {
	stub := newJSONStub(t, 200, `{"results":[]}`)

	_, err := newClient(stub).CreatePosts(context.Background(), CreatePostsParams{
		Text:            "our new roast is out",
		ConnectionSlugs: []string{"acme_linkedin"},
		ProfileID:       "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"text":"our new roast is out","connectionSlugs":["acme_linkedin"],"profileId":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestCreatePostsSendsScheduledForWhenItIsGiven(t *testing.T) {
	stub := newJSONStub(t, 200, `{"results":[]}`)

	_, err := newClient(stub).CreatePosts(context.Background(), CreatePostsParams{
		Text:            "scheduled from a real integration",
		ConnectionSlugs: []string{"linkedin"},
		ScheduledFor:    "2026-09-15T15:00:00Z",
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"text":"scheduled from a real integration","connectionSlugs":["linkedin"],"scheduledFor":"2026-09-15T15:00:00Z"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestCreatePostsSendsTheTimezoneAlongsideScheduledFor(t *testing.T) {
	stub := newJSONStub(t, 200, `{"results":[]}`)

	_, err := newClient(stub).CreatePosts(context.Background(), CreatePostsParams{
		Text:            "nine in the morning, Helsinki time",
		ConnectionSlugs: []string{"linkedin"},
		ScheduledFor:    "2026-09-15T09:00:00",
		Timezone:        "Europe/Helsinki",
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"text":"nine in the morning, Helsinki time","connectionSlugs":["linkedin"],"scheduledFor":"2026-09-15T09:00:00","timezone":"Europe/Helsinki"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestCreatePostsSendsQueueAndGetsBackTheSlotItTook(t *testing.T) {
	stub := newJSONStub(t, 200, `{"results":[{"connectionSlug":"linkedin","status":"scheduled","postId":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","url":null,"scheduledFor":"2026-09-07T06:00:00.000Z","threadCount":0,"hasFirstComment":false,"error":null}]}`)

	response, err := newClient(stub).CreatePosts(context.Background(), CreatePostsParams{
		Text:            "goes out at the next open slot",
		ConnectionSlugs: []string{"linkedin"},
		Queue:           true,
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"text":"goes out at the next open slot","connectionSlugs":["linkedin"],"queue":true}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}

	want := CreatePostsResponse{
		Results: Results{
			{
				ConnectionSlug:  "linkedin",
				Status:          PostStatusScheduled,
				PostID:          stringPointer("6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10"),
				URL:             nil,
				ScheduledFor:    stringPointer("2026-09-07T06:00:00.000Z"),
				ThreadCount:     0,
				HasFirstComment: false,
				Error:           nil,
			},
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestCreatePostsLeavesQueueOutWhenItIsFalse(t *testing.T) {
	stub := newJSONStub(t, 200, `{"results":[]}`)

	_, err := newClient(stub).CreatePosts(context.Background(), CreatePostsParams{
		Text:            "shipped the new api docs today",
		ConnectionSlugs: []string{"linkedin"},
		Queue:           false,
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"text":"shipped the new api docs today","connectionSlugs":["linkedin"]}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestCreatePostsSendsMediaIdsThreadAndFirstComment(t *testing.T) {
	stub := newJSONStub(t, 200, `{"results":[]}`)

	_, err := newClient(stub).CreatePosts(context.Background(), CreatePostsParams{
		Text:            "the head post",
		ConnectionSlugs: []string{"x", "bluesky"},
		MediaIDs:        []string{"9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d"},
		Thread:          []string{"second", "third"},
		FirstComment:    "the link is here",
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"text":"the head post","connectionSlugs":["x","bluesky"],"mediaIds":["9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d"],"thread":["second","third"],"firstComment":"the link is here"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestCreatePostsSendsMediaWithAltText(t *testing.T) {
	stub := newJSONStub(t, 200, `{"results":[]}`)

	_, err := newClient(stub).CreatePosts(context.Background(), CreatePostsParams{
		Text:            "with a described image",
		ConnectionSlugs: []string{"bluesky"},
		Media: []PostMediaItem{
			{ID: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d", AltText: "the new docs page"},
			{ID: "1f2e3d4c-5b6a-4798-8a1b-2c3d4e5f6a7b"},
		},
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"text":"with a described image","connectionSlugs":["bluesky"],"media":[{"id":"9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d","altText":"the new docs page"},{"id":"1f2e3d4c-5b6a-4798-8a1b-2c3d4e5f6a7b"}]}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestCreatePostsSendsMediaUrlsToFetchTheImagesItself(t *testing.T) {
	stub := newJSONStub(t, 200, `{"results":[]}`)

	_, err := newClient(stub).CreatePosts(context.Background(), CreatePostsParams{
		Text:            "fetched rather than uploaded",
		ConnectionSlugs: []string{"bluesky"},
		MediaURLs:       []string{"https://example.com/shot.png"},
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"text":"fetched rather than uploaded","connectionSlugs":["bluesky"],"mediaUrls":["https://example.com/shot.png"]}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestCreatePostsStoresADraftWithItsTags(t *testing.T) {
	stub := newJSONStub(t, 200, `{"results":[{"connectionSlug":"linkedin","status":"draft","postId":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","url":null,"scheduledFor":null,"threadCount":0,"hasFirstComment":false,"error":null}]}`)

	response, err := newClient(stub).CreatePosts(context.Background(), CreatePostsParams{
		Text:            "half an idea",
		ConnectionSlugs: []string{"linkedin"},
		IsDraft:         true,
		Tags:            []string{"launch", "q3"},
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"text":"half an idea","connectionSlugs":["linkedin"],"isDraft":true,"tags":["launch","q3"]}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}

	want := CreatePostsResponse{
		Results: Results{
			{
				ConnectionSlug:  "linkedin",
				Status:          PostStatusDraft,
				PostID:          stringPointer("6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10"),
				URL:             nil,
				ScheduledFor:    nil,
				ThreadCount:     0,
				HasFirstComment: false,
				Error:           nil,
			},
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestCreatePostsLeavesIsDraftOutWhenItIsFalse(t *testing.T) {
	stub := newJSONStub(t, 200, `{"results":[]}`)

	_, err := newClient(stub).CreatePosts(context.Background(), CreatePostsParams{
		Text:            "not a draft",
		ConnectionSlugs: []string{"linkedin"},
		IsDraft:         false,
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"text":"not a draft","connectionSlugs":["linkedin"]}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestPublishPostWithAnEmptyBodySendsTheDraftNow(t *testing.T) {
	stub := newJSONStub(t, 200, `{"result":{"connectionSlug":"linkedin","status":"sent","postId":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","url":"https://www.linkedin.com/feed/update/urn:li:share:1234567890","scheduledFor":null,"threadCount":0,"hasFirstComment":false,"error":null}}`)

	response, err := newClient(stub).PublishPost(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", PublishPostParams{})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "POST" {
		t.Errorf("method: got %q, want %q", request.method, "POST")
	}

	wantURL := "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10/publish"

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	if request.body != "{}" {
		t.Errorf("body: got %s, want %s", request.body, "{}")
	}

	want := PublishPostResponse{
		Result: PostResult{
			ConnectionSlug:  "linkedin",
			Status:          PostStatusSent,
			PostID:          stringPointer("6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10"),
			URL:             stringPointer("https://www.linkedin.com/feed/update/urn:li:share:1234567890"),
			ScheduledFor:    nil,
			ThreadCount:     0,
			HasFirstComment: false,
			Error:           nil,
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestPublishPostReadsTheWarningInsideTheGraceWindow(t *testing.T) {
	stub := newJSONStub(t, 200, `{"result":{"connectionSlug":"linkedin","status":"sent","postId":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","url":"https://www.linkedin.com/feed/update/urn:li:share:1234567890","scheduledFor":null,"threadCount":0,"hasFirstComment":false,"warning":"`+graceWarning+`","error":null}}`)

	response, err := newClient(stub).PublishPost(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", PublishPostParams{})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	want := PublishPostResponse{
		Result: PostResult{
			ConnectionSlug:  "linkedin",
			Status:          PostStatusSent,
			PostID:          stringPointer("6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10"),
			URL:             stringPointer("https://www.linkedin.com/feed/update/urn:li:share:1234567890"),
			ScheduledFor:    nil,
			ThreadCount:     0,
			HasFirstComment: false,
			Warning:         graceWarning,
			Error:           nil,
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestPublishPostSendsTheQueueFlagAndTheIdempotencyKey(t *testing.T) {
	stub := newJSONStub(t, 200, `{"result":{"connectionSlug":"linkedin","status":"scheduled","postId":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","url":null,"scheduledFor":"2026-09-07T06:00:00.000Z","threadCount":0,"hasFirstComment":false,"error":null}}`)

	_, err := newClient(stub).PublishPost(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", PublishPostParams{
		Queue:          true,
		IdempotencyKey: "publish-the-launch-draft",
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.headers.Get("idempotency-key") != "publish-the-launch-draft" {
		t.Errorf("idempotency-key: got %q, want %q", request.headers.Get("idempotency-key"), "publish-the-launch-draft")
	}

	if request.body != `{"queue":true}` {
		t.Errorf("body: got %s, want %s", request.body, `{"queue":true}`)
	}
}

func TestPublishPostSendsScheduledForAndTheTimezone(t *testing.T) {
	stub := newJSONStub(t, 200, `{"result":{"connectionSlug":"linkedin","status":"scheduled","postId":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","url":null,"scheduledFor":"2026-09-15T06:00:00.000Z","threadCount":0,"hasFirstComment":false,"error":null}}`)

	_, err := newClient(stub).PublishPost(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", PublishPostParams{
		ScheduledFor: "2026-09-15T09:00:00",
		Timezone:     "Europe/Helsinki",
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"scheduledFor":"2026-09-15T09:00:00","timezone":"Europe/Helsinki"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestUpdateDraftPatchesOnlyWhatItWasGiven(t *testing.T) {
	stub := newJSONStub(t, 200, `{"post":{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","connectionSlug":"linkedin","text":"a whole idea","status":"draft","url":null,"scheduledFor":null,"createdAt":"2026-08-26T09:24:11.412Z","tags":["launch","q3"],"platformPostId":null,"deletedAt":null,"error":null}}`)

	response, err := newClient(stub).UpdateDraft(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", UpdatePostParams{
		Text: "a whole idea",
		Tags: &[]string{"launch", "q3"},
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "PATCH" {
		t.Errorf("method: got %q, want %q", request.method, "PATCH")
	}

	if request.url != "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10")
	}

	wantBody := `{"text":"a whole idea","tags":["launch","q3"]}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}

	want := UpdatePostResponse{
		Post: Post{
			ID:             "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
			ConnectionSlug: "linkedin",
			Text:           "a whole idea",
			Status:         PostStatusDraft,
			URL:            nil,
			ScheduledFor:   nil,
			CreatedAt:      "2026-08-26T09:24:11.412Z",
			Tags:           []string{"launch", "q3"},
			PlatformPostID: nil,
			DeletedAt:      nil,
			Error:          nil,
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestUpdateDraftSendsAnEmptyListToClearTheThreadAndTheImages(t *testing.T) {
	stub := newJSONStub(t, 200, `{"post":{}}`)

	_, err := newClient(stub).UpdateDraft(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", UpdatePostParams{
		Thread:   &[]string{},
		MediaIDs: &[]string{},
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"thread":[],"mediaIds":[]}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestUpdateDraftSendsTheFirstCommentAsAString(t *testing.T) {
	stub := newJSONStub(t, 200, `{"post":{}}`)

	_, err := newClient(stub).UpdateDraft(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", UpdatePostParams{
		FirstComment: "the link is here",
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"firstComment":"the link is here"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestUpdateDraftSendsAnExplicitNullToClearTheFirstComment(t *testing.T) {
	stub := newJSONStub(t, 200, `{"post":{}}`)

	_, err := newClient(stub).UpdateDraft(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", UpdatePostParams{
		ClearFirstComment: true,
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"firstComment":null}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestUpdateDraftSendsTheMediaWithAltTextItWasGiven(t *testing.T) {
	stub := newJSONStub(t, 200, `{"post":{}}`)

	_, err := newClient(stub).UpdateDraft(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", UpdatePostParams{
		Media: &[]PostMediaItem{{ID: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d", AltText: "the new docs page"}},
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"media":[{"id":"9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d","altText":"the new docs page"}]}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestUpdateDraftRefusesBothAFirstCommentAndClearingItBeforeTheCall(t *testing.T) {
	stub := newJSONStub(t, 200, `{"post":{}}`)

	_, err := newClient(stub).UpdateDraft(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", UpdatePostParams{
		FirstComment:      "the link is here",
		ClearFirstComment: true,
	})

	if err == nil {
		t.Fatalf("err: got nil, want an error")
	}

	if len(stub.requests) != 0 {
		t.Errorf("requests: got %d, want 0", len(stub.requests))
	}
}

func TestUpdateDraftMovesAScheduledPostsTime(t *testing.T) {
	stub := newJSONStub(t, 200, `{"post":{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","connectionSlug":"linkedin","text":"a better idea","status":"scheduled","url":null,"scheduledFor":"2026-09-20T15:00:00.000Z","createdAt":"2026-08-26T09:24:11.412Z","tags":[],"platformPostId":null,"deletedAt":null,"error":null}}`)

	response, err := newClient(stub).UpdateDraft(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", UpdatePostParams{
		ScheduledFor: "2026-09-20T18:00:00",
		Timezone:     "Europe/Helsinki",
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"scheduledFor":"2026-09-20T18:00:00","timezone":"Europe/Helsinki"}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}

	if response.Post.Status != PostStatusScheduled {
		t.Errorf("status: got %q, want %q", response.Post.Status, PostStatusScheduled)
	}
}

func TestUpdateDraftTakesTheNextFreeSlotWithQueue(t *testing.T) {
	stub := newJSONStub(t, 200, `{"post":{}}`)

	_, err := newClient(stub).UpdateDraft(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", UpdatePostParams{
		Queue: true,
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantBody := `{"queue":true}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}
}

func TestUpdateDraftSendsAnEmptyBodyWhenItWasGivenNothing(t *testing.T) {
	stub := newJSONStub(t, 200, `{"post":{}}`)

	_, err := newClient(stub).UpdateDraft(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", UpdatePostParams{})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.body != "{}" {
		t.Errorf("body: got %s, want %s", request.body, "{}")
	}
}

func TestResultsFailedKeepsOnlyTheFailedItems(t *testing.T) {
	results := Results{
		{ConnectionSlug: "linkedin", Status: PostStatusSent},
		{ConnectionSlug: "x", Status: PostStatusFailed, Error: &PostError{Code: "platform_rejected", Message: "X: duplicate post was detected"}},
		{ConnectionSlug: "bluesky", Status: PostStatusScheduled},
	}

	want := Results{
		{ConnectionSlug: "x", Status: PostStatusFailed, Error: &PostError{Code: "platform_rejected", Message: "X: duplicate post was detected"}},
	}

	if !reflect.DeepEqual(results.Failed(), want) {
		t.Errorf("failed: got %+v, want %+v", results.Failed(), want)
	}
}

func TestResultsFailedIsEmptyWhenEverythingWentOut(t *testing.T) {
	results := Results{
		{ConnectionSlug: "linkedin", Status: PostStatusSent},
	}

	if !reflect.DeepEqual(results.Failed(), Results{}) {
		t.Errorf("failed: got %+v, want %+v", results.Failed(), Results{})
	}
}

func TestUploadMediaSendsTheRawBytesWithTheContentTypeAndAltText(t *testing.T) {
	stub := newJSONStub(t, 200, `{"mediaId":"9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d","contentType":"image/png","sizeBytes":4}`)

	response, err := newClient(stub).UploadMedia(context.Background(), UploadMediaParams{
		Bytes:       []byte("PNGB"),
		ContentType: MediaContentTypePNG,
		AltText:     "the new docs page",
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "POST" {
		t.Errorf("method: got %q, want %q", request.method, "POST")
	}

	if request.url != "/api/v2/media?alt_text=the+new+docs+page" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/media?alt_text=the+new+docs+page")
	}

	if request.headers.Get("content-type") != "image/png" {
		t.Errorf("content-type: got %q, want %q", request.headers.Get("content-type"), "image/png")
	}

	// The body is the bytes themselves, with no multipart around them
	if request.body != "PNGB" {
		t.Errorf("body: got %q, want %q", request.body, "PNGB")
	}

	want := CreateMediaResponse{
		MediaID:     "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
		ContentType: MediaContentTypePNG,
		SizeBytes:   4,
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

// A gif of one transparent pixel starts with the bytes "GIF89a", and 0x3b ends
// it. Nothing here should touch either.
func TestUploadMediaSendsEveryByteOfTheBodyWhateverTheContentTypeIs(t *testing.T) {
	stub := newJSONStub(t, 200, `{"mediaId":"9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d","contentType":"image/gif","sizeBytes":7}`)

	_, err := newClient(stub).UploadMedia(context.Background(), UploadMediaParams{
		Bytes:       []byte("GIF89a\x3b"),
		ContentType: MediaContentTypeGIF,
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.url != "/api/v2/media" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/media")
	}

	if request.headers.Get("content-type") != "image/gif" {
		t.Errorf("content-type: got %q, want %q", request.headers.Get("content-type"), "image/gif")
	}

	if request.body != "GIF89a\x3b" {
		t.Errorf("body: got %q, want %q", request.body, "GIF89a\x3b")
	}
}

func TestUploadMediaRefusesAnEmptyContentTypeBeforeTheCall(t *testing.T) {
	stub := newJSONStub(t, 200, `{"mediaId":"9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d","contentType":"image/png","sizeBytes":4}`)

	_, err := newClient(stub).UploadMedia(context.Background(), UploadMediaParams{
		Bytes: []byte("PNGB"),
	})

	if err == nil {
		t.Fatalf("err: got nil, want an error")
	}

	if err.Error() != "yeetpost: contentType is required" {
		t.Errorf("err: got %q, want %q", err.Error(), "yeetpost: contentType is required")
	}

	if len(stub.requests) != 0 {
		t.Errorf("requests: got %d, want 0", len(stub.requests))
	}
}

func TestGetMediaReturnsTheBytesAndTheContentType(t *testing.T) {
	stub := newStubServer(t, 200, "image/png", "PNGB")

	response, err := newClient(stub).GetMedia(context.Background(), "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "GET" {
		t.Errorf("method: got %q, want %q", request.method, "GET")
	}

	if request.url != "/api/v2/media/9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/media/9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d")
	}

	want := GetMediaResponse{Bytes: []byte("PNGB"), ContentType: MediaContentTypePNG}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestGetMediaKeepsOnlyTheMediaTypeWhenTheHeaderCarriesParameters(t *testing.T) {
	stub := newStubServer(t, 200, "image/png; charset=binary", "PNGB")

	response, err := newClient(stub).GetMedia(context.Background(), "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	want := GetMediaResponse{Bytes: []byte("PNGB"), ContentType: MediaContentTypePNG}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestDeleteMediaSendsADelete(t *testing.T) {
	stub := newJSONStub(t, 200, `{"id":"9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d","deleted":true}`)

	response, err := newClient(stub).DeleteMedia(context.Background(), "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "DELETE" {
		t.Errorf("method: got %q, want %q", request.method, "DELETE")
	}

	if request.url != "/api/v2/media/9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/media/9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d")
	}

	want := DeleteMediaResponse{ID: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d", Deleted: true}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestListPostsPutsItsFiltersInTheQueryString(t *testing.T) {
	stub := newJSONStub(t, 200, `{"posts":[{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","connectionSlug":"linkedin","text":"shipped the new api docs today","status":"scheduled","url":null,"scheduledFor":"2026-09-15T15:00:00.000Z","createdAt":"2026-08-26T09:24:11.412Z","tags":["launch"],"platformPostId":null,"deletedAt":null,"error":null}],"limit":10,"offset":20}`)

	response, err := newClient(stub).ListPosts(context.Background(), ListPostsParams{
		Status: PostStatusScheduled,
		Limit:  10,
		Offset: 20,
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/posts?limit=10&offset=20&status=scheduled"

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	want := GetPostsResponse{
		Posts: []Post{
			{
				ID:             "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
				ConnectionSlug: "linkedin",
				Text:           "shipped the new api docs today",
				Status:         PostStatusScheduled,
				URL:            nil,
				ScheduledFor:   stringPointer("2026-09-15T15:00:00.000Z"),
				CreatedAt:      "2026-08-26T09:24:11.412Z",
				Tags:           []string{"launch"},
				PlatformPostID: nil,
				DeletedAt:      nil,
				Error:          nil,
			},
		},
		Limit:  10,
		Offset: 20,
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestGetPostMetricsReadsTheLatestAndTheWholeHistory(t *testing.T) {
	stub := newJSONStub(t, 200, `{"latest":{"fetchedAt":"2026-08-30T10:00:00.000Z","impressions":null,"likes":12,"reposts":3,"replies":1,"clicks":null},"history":[{"fetchedAt":"2026-08-29T10:00:00.000Z","impressions":null,"likes":4,"reposts":1,"replies":0,"clicks":null},{"fetchedAt":"2026-08-30T10:00:00.000Z","impressions":null,"likes":12,"reposts":3,"replies":1,"clicks":null}]}`)

	response, err := newClient(stub).GetPostMetrics(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10/metrics"

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	want := GetPostMetricsResponse{
		Latest: &MetricsRead{
			FetchedAt: "2026-08-30T10:00:00.000Z",
			// Bluesky reports no impressions, and nil says so rather than
			// claiming zero
			Impressions: nil,
			Likes:       intPointer(12),
			Reposts:     intPointer(3),
			Replies:     intPointer(1),
			Clicks:      nil,
		},
		History: []MetricsRead{
			{
				FetchedAt:   "2026-08-29T10:00:00.000Z",
				Impressions: nil,
				Likes:       intPointer(4),
				Reposts:     intPointer(1),
				Replies:     intPointer(0),
				Clicks:      nil,
			},
			{
				FetchedAt:   "2026-08-30T10:00:00.000Z",
				Impressions: nil,
				Likes:       intPointer(12),
				Reposts:     intPointer(3),
				Replies:     intPointer(1),
				Clicks:      nil,
			},
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestGetPostMetricsAnswersANilLatestBeforeTheFirstRead(t *testing.T) {
	stub := newJSONStub(t, 200, `{"latest":null,"history":[]}`)

	response, err := newClient(stub).GetPostMetrics(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	want := GetPostMetricsResponse{Latest: nil, History: []MetricsRead{}}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestGetAnalyticsPutsItsWindowAndFiltersInTheQueryString(t *testing.T) {
	stub := newJSONStub(t, 200, `{"totals":{"posts":2,"impressions":0,"likes":16,"reposts":4,"replies":1,"clicks":0},"days":[{"day":"2026-08-29","posts":1,"impressions":0,"likes":4,"reposts":1,"replies":0},{"day":"2026-08-30","posts":1,"impressions":0,"likes":12,"reposts":3,"replies":1}],"byPlatform":[{"platformId":"bluesky","posts":2,"impressions":0,"likes":16,"reposts":4,"replies":1,"clicks":0}],"from":"2026-08-29","to":"2026-08-30"}`)

	response, err := newClient(stub).GetAnalytics(context.Background(), GetAnalyticsParams{
		From:     "2026-08-29",
		To:       "2026-08-30",
		Platform: "bluesky",
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/analytics?from=2026-08-29&platform=bluesky&to=2026-08-30"

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	want := GetAnalyticsResponse{
		Totals: AnalyticsTotals{
			Posts:       2,
			Impressions: 0,
			Likes:       16,
			Reposts:     4,
			Replies:     1,
			Clicks:      0,
		},
		Days: []AnalyticsDay{
			{Day: "2026-08-29", Posts: 1, Impressions: 0, Likes: 4, Reposts: 1, Replies: 0},
			{Day: "2026-08-30", Posts: 1, Impressions: 0, Likes: 12, Reposts: 3, Replies: 1},
		},
		ByPlatform: []AnalyticsPlatform{
			{PlatformID: "bluesky", Posts: 2, Impressions: 0, Likes: 16, Reposts: 4, Replies: 1, Clicks: 0},
		},
		From: "2026-08-29",
		To:   "2026-08-30",
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestGetAnalyticsSendsNoQueryStringWithoutAWindow(t *testing.T) {
	stub := newJSONStub(t, 200, `{"totals":{"posts":0,"impressions":0,"likes":0,"reposts":0,"replies":0,"clicks":0},"days":[],"byPlatform":[],"from":"2026-08-01","to":"2026-08-30"}`)

	_, err := newClient(stub).GetAnalytics(context.Background(), GetAnalyticsParams{})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/analytics"

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}
}

func TestParsePostMetricsWebhookEventReadsADailyDigest(t *testing.T) {
	body := []byte(`{"eventId":"8d3f2b7c-4e1a-4c6d-9b0f-1a2b3c4d5e6f","event":"post.metrics","timestamp":"2026-08-30T10:00:00.120Z","post":{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","connectionSlug":"bluesky","profileId":null,"platformId":"bluesky","url":"https://bsky.app/profile/alex.bsky.social/post/3l2k"},"metrics":{"fetchedAt":"2026-08-30T10:00:00.000Z","impressions":null,"likes":12,"reposts":3,"replies":1,"clicks":null}}`)

	event, err := ParsePostMetricsWebhookEvent(body)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	want := PostMetricsEvent{
		EventID:   "8d3f2b7c-4e1a-4c6d-9b0f-1a2b3c4d5e6f",
		Event:     EventPostMetrics,
		Timestamp: "2026-08-30T10:00:00.120Z",
		Post: MetricsEventPost{
			ID:             "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
			ConnectionSlug: "bluesky",
			ProfileID:      nil,
			PlatformID:     "bluesky",
			URL:            stringPointer("https://bsky.app/profile/alex.bsky.social/post/3l2k"),
		},
		Metrics: MetricsRead{
			FetchedAt:   "2026-08-30T10:00:00.000Z",
			Impressions: nil,
			Likes:       intPointer(12),
			Reposts:     intPointer(3),
			Replies:     intPointer(1),
			Clicks:      nil,
		},
	}

	if !reflect.DeepEqual(event, want) {
		t.Errorf("event: got %+v, want %+v", event, want)
	}
}

func TestListPostsRepeatsTheTagParameterOncePerTag(t *testing.T) {
	stub := newJSONStub(t, 200, `{"posts":[],"limit":25,"offset":0}`)

	_, err := newClient(stub).ListPosts(context.Background(), ListPostsParams{
		Status: PostStatusDraft,
		Tag:    []string{"launch", "q3"},
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/posts?status=draft&tag=launch&tag=q3"

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}
}

func TestListPostsNarrowsToOneProfile(t *testing.T) {
	stub := newJSONStub(t, 200, `{"posts":[{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","connectionSlug":"acme_linkedin","profileId":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","text":"our new roast is out","status":"sent","url":null,"scheduledFor":null,"createdAt":"2026-08-29T09:24:11.412Z","tags":[],"platformPostId":null,"deletedAt":null,"error":null}],"limit":25,"offset":0}`)

	response, err := newClient(stub).ListPosts(context.Background(), ListPostsParams{
		ProfileID: "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b",
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/posts?profileId=b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b"

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	if !reflect.DeepEqual(response.Posts[0].ProfileID, stringPointer("b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b")) {
		t.Errorf("profileId: got %v, want %q", response.Posts[0].ProfileID, "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b")
	}
}

func TestListPostsSendsNoQueryStringWithoutFilters(t *testing.T) {
	stub := newJSONStub(t, 200, `{"posts":[],"limit":25,"offset":0}`)

	_, err := newClient(stub).ListPosts(context.Background(), ListPostsParams{})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.url != "/api/v2/posts" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/posts")
	}

	if request.body != "" {
		t.Errorf("body: got %q, want %q", request.body, "")
	}
}

func TestListPostsPutsTheSchedulingAndTargetingFiltersInTheQueryString(t *testing.T) {
	stub := newJSONStub(t, 200, `{"posts":[],"limit":25,"offset":0}`)

	_, err := newClient(stub).ListPosts(context.Background(), ListPostsParams{
		ScheduledAfter:  "2026-09-01T00:00:00Z",
		ScheduledBefore: "2026-09-30T00:00:00Z",
		ConnectionSlug:  "linkedin",
		Platform:        "linkedin",
		SendGroupID:     "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/posts?connectionSlug=linkedin&platform=linkedin&scheduledAfter=2026-09-01T00%3A00%3A00Z&scheduledBefore=2026-09-30T00%3A00%3A00Z&sendGroupId=9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68"

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}
}

func TestGetPostReturnsThePost(t *testing.T) {
	stub := newJSONStub(t, 200, `{"post":{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","connectionSlug":"x","text":"shipped the new api docs today","status":"failed","url":null,"scheduledFor":null,"createdAt":"2026-08-26T09:24:11.412Z","tags":[],"platformPostId":null,"deletedAt":null,"error":{"code":"platform_rejected","message":"X: duplicate post was detected"}}}`)

	response, err := newClient(stub).GetPost(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "GET" {
		t.Errorf("method: got %q, want %q", request.method, "GET")
	}

	if request.url != "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10")
	}

	want := GetPostResponse{
		Post: Post{
			ID:             "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
			ConnectionSlug: "x",
			Text:           "shipped the new api docs today",
			Status:         PostStatusFailed,
			URL:            nil,
			ScheduledFor:   nil,
			CreatedAt:      "2026-08-26T09:24:11.412Z",
			Tags:           []string{},
			PlatformPostID: nil,
			DeletedAt:      nil,
			Error:          &PostError{Code: "platform_rejected", Message: "X: duplicate post was detected"},
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestGetPostReadsItsMediaThreadFirstCommentAndPublishedAt(t *testing.T) {
	stub := newJSONStub(t, 200, `{"post":{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","connectionSlug":"x","text":"the head post","status":"sent","url":"https://x.com/alexdoe/status/1234567890","scheduledFor":null,"createdAt":"2026-08-26T09:24:11.412Z","tags":[],"platformPostId":"1234567890","deletedAt":null,"error":null,"media":[{"id":"9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d","altText":"the new docs page"}],"thread":["second","third"],"firstComment":"the link is here","publishedAt":"2026-08-26T09:24:12.000Z"}}`)

	response, err := newClient(stub).GetPost(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	want := GetPostResponse{
		Post: Post{
			ID:             "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
			ConnectionSlug: "x",
			Text:           "the head post",
			Status:         PostStatusSent,
			URL:            stringPointer("https://x.com/alexdoe/status/1234567890"),
			ScheduledFor:   nil,
			CreatedAt:      "2026-08-26T09:24:11.412Z",
			Tags:           []string{},
			PlatformPostID: stringPointer("1234567890"),
			DeletedAt:      nil,
			Error:          nil,
			Media: []PostMedia{
				{ID: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d", AltText: stringPointer("the new docs page")},
			},
			Thread:       []string{"second", "third"},
			FirstComment: stringPointer("the link is here"),
			PublishedAt:  stringPointer("2026-08-26T09:24:12.000Z"),
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestGetPostReadsThePlatformPostIdOfADeletedPost(t *testing.T) {
	stub := newJSONStub(t, 200, `{"post":{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","connectionSlug":"x","text":"shipped the new api docs today","status":"deleted","url":"https://x.com/alexdoe/status/1234567890","scheduledFor":null,"createdAt":"2026-08-26T09:24:11.412Z","tags":["launch","q3"],"platformPostId":"1234567890","deletedAt":"2026-08-29T11:02:44.108Z","error":null}}`)

	response, err := newClient(stub).GetPost(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	want := GetPostResponse{
		Post: Post{
			ID:             "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
			ConnectionSlug: "x",
			Text:           "shipped the new api docs today",
			Status:         PostStatusDeleted,
			URL:            stringPointer("https://x.com/alexdoe/status/1234567890"),
			ScheduledFor:   nil,
			CreatedAt:      "2026-08-26T09:24:11.412Z",
			Tags:           []string{"launch", "q3"},
			PlatformPostID: stringPointer("1234567890"),
			DeletedAt:      stringPointer("2026-08-29T11:02:44.108Z"),
			Error:          nil,
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestDeletePostSendsADeleteAndCancelsAScheduledPost(t *testing.T) {
	stub := newJSONStub(t, 200, `{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","status":"cancelled"}`)

	response, err := newClient(stub).DeletePost(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "DELETE" {
		t.Errorf("method: got %q, want %q", request.method, "DELETE")
	}

	if request.url != "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10")
	}

	want := DeletePostResponse{ID: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", Status: PostStatusCancelled}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestDeletePostTakesAPublishedPostDownAndAnswersWithWhenItWent(t *testing.T) {
	stub := newJSONStub(t, 200, `{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","status":"deleted","deletedAt":"2026-08-29T11:02:44.108Z"}`)

	response, err := newClient(stub).DeletePost(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	want := DeletePostResponse{
		ID:        "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
		Status:    PostStatusDeleted,
		DeletedAt: stringPointer("2026-08-29T11:02:44.108Z"),
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestDeletePostReallyDeletesADraft(t *testing.T) {
	stub := newJSONStub(t, 200, `{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","deleted":true}`)

	response, err := newClient(stub).DeletePost(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	want := DeletePostResponse{ID: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", Deleted: true}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestCancelPostIsTheOldNameOfDeletePost(t *testing.T) {
	stub := newJSONStub(t, 200, `{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","status":"cancelled"}`)

	response, err := newClient(stub).CancelPost(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "DELETE" {
		t.Errorf("method: got %q, want %q", request.method, "DELETE")
	}

	want := DeletePostResponse{ID: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", Status: PostStatusCancelled}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestRetryPostPostsToTheRetryPath(t *testing.T) {
	stub := newJSONStub(t, 200, `{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","status":"sent"}`)

	response, err := newClient(stub).RetryPost(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "POST" {
		t.Errorf("method: got %q, want %q", request.method, "POST")
	}

	if request.url != "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10/retry" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10/retry")
	}

	want := RetryPostResponse{ID: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", Status: "sent"}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestRetryPostReadsTheWarningInsideTheGraceWindow(t *testing.T) {
	stub := newJSONStub(t, 200, `{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","status":"sent","warning":"ai polish failed, sent as written"}`)

	response, err := newClient(stub).RetryPost(context.Background(), "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	want := RetryPostResponse{
		ID:      "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
		Status:  "sent",
		Warning: "ai polish failed, sent as written",
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestCreateWebhookReturnsTheSecretWhichIsOnlySentOnce(t *testing.T) {
	stub := newJSONStub(t, 200, `{"webhook":{"id":"2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90","url":"https://example.com/hooks/yeetpost","events":["post.sent"],"secret":"yp_whsec_3f1a","createdAt":"2026-08-26T09:24:11.412Z"}}`)

	response, err := newClient(stub).CreateWebhook(context.Background(), CreateWebhookParams{
		URL:    "https://example.com/hooks/yeetpost",
		Events: []EventName{EventPostSent},
	})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "POST" {
		t.Errorf("method: got %q, want %q", request.method, "POST")
	}

	if request.url != "/api/v2/webhooks" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/webhooks")
	}

	wantBody := `{"url":"https://example.com/hooks/yeetpost","events":["post.sent"]}`

	if request.body != wantBody {
		t.Errorf("body: got %s, want %s", request.body, wantBody)
	}

	want := CreateWebhookResponse{
		Webhook: WebhookWithSecret{
			ID:        "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90",
			URL:       "https://example.com/hooks/yeetpost",
			Events:    []EventName{EventPostSent},
			Secret:    "yp_whsec_3f1a",
			CreatedAt: "2026-08-26T09:24:11.412Z",
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestListWebhooksReturnsThemWithoutSecrets(t *testing.T) {
	stub := newJSONStub(t, 200, `{"webhooks":[{"id":"2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90","url":"https://example.com/hooks/yeetpost","events":["post.sent","post.failed"],"createdAt":"2026-08-26T09:24:11.412Z"}]}`)

	response, err := newClient(stub).ListWebhooks(context.Background())
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.url != "/api/v2/webhooks" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/webhooks")
	}

	want := GetWebhooksResponse{
		Webhooks: []Webhook{
			{
				ID:        "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90",
				URL:       "https://example.com/hooks/yeetpost",
				Events:    []EventName{EventPostSent, EventPostFailed},
				CreatedAt: "2026-08-26T09:24:11.412Z",
			},
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestDeleteWebhookSendsADelete(t *testing.T) {
	stub := newJSONStub(t, 200, `{"id":"2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90","deleted":true}`)

	response, err := newClient(stub).DeleteWebhook(context.Background(), "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "DELETE" {
		t.Errorf("method: got %q, want %q", request.method, "DELETE")
	}

	if request.url != "/api/v2/webhooks/2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/webhooks/2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90")
	}

	want := DeleteWebhookResponse{ID: "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90", Deleted: true}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestListWebhookDeliveriesPutsItsFilterAndCursorInTheQueryString(t *testing.T) {
	stub := newJSONStub(t, 200, `{"deliveries":[{"id":"1c4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f60","eventId":"1c4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f60","event":"post.failed","status":"dead","attempts":7,"createdAt":"2026-08-25T18:02:44.118Z","nextAttemptAt":"2026-08-26T14:39:12.882Z","deliveredAt":null,"deadAt":"2026-08-26T14:39:13.204Z","lastStatusCode":500,"lastError":"response status 500"}],"limit":10,"hasMore":true}`)

	response, err := newClient(stub).ListWebhookDeliveries(
		context.Background(),
		"2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90",
		ListWebhookDeliveriesParams{
			// Status is a DeliveryStatusFilter rather than a DeliveryStatus, so
			// the one status the endpoint does not filter by, processing, has no
			// constant here and does not compile.
			Status:        DeliveryStatusFilterDead,
			Limit:         10,
			StartingAfter: "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
		},
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/webhooks/2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90/deliveries?limit=10&startingAfter=9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68&status=dead"

	if request.method != "GET" {
		t.Errorf("method: got %q, want %q", request.method, "GET")
	}

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	want := GetWebhookDeliveriesResponse{
		Deliveries: []WebhookDelivery{
			{
				ID:             "1c4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f60",
				EventID:        "1c4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f60",
				Event:          EventPostFailed,
				Status:         DeliveryStatusDead,
				Attempts:       7,
				CreatedAt:      "2026-08-25T18:02:44.118Z",
				NextAttemptAt:  "2026-08-26T14:39:12.882Z",
				DeliveredAt:    nil,
				DeadAt:         stringPointer("2026-08-26T14:39:13.204Z"),
				LastStatusCode: intPointer(500),
				LastError:      stringPointer("response status 500"),
			},
		},
		Limit:   10,
		HasMore: true,
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestReplayDeliveryPostsToTheReplayPath(t *testing.T) {
	stub := newJSONStub(t, 200, `{"delivery":{"id":"9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68","eventId":"9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68","event":"post.sent","status":"pending","attempts":0,"createdAt":"2026-08-26T09:24:12.004Z","nextAttemptAt":"2026-08-26T11:02:41.880Z","deliveredAt":null,"deadAt":null,"lastStatusCode":null,"lastError":null}}`)

	response, err := newClient(stub).ReplayDelivery(
		context.Background(),
		"2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90",
		"9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
	)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)
	wantURL := "/api/v2/webhooks/2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90/deliveries/9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68/replay"

	if request.method != "POST" {
		t.Errorf("method: got %q, want %q", request.method, "POST")
	}

	if request.url != wantURL {
		t.Errorf("url: got %q, want %q", request.url, wantURL)
	}

	want := ReplayWebhookDeliveryResponse{
		Delivery: WebhookDelivery{
			ID:             "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
			EventID:        "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
			Event:          EventPostSent,
			Status:         DeliveryStatusPending,
			Attempts:       0,
			CreatedAt:      "2026-08-26T09:24:12.004Z",
			NextAttemptAt:  "2026-08-26T11:02:41.880Z",
			DeliveredAt:    nil,
			DeadAt:         nil,
			LastStatusCode: nil,
			LastError:      nil,
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestSendTestEventPostsToTheTestPath(t *testing.T) {
	stub := newJSONStub(t, 200, `{"delivery":{"id":"4e8b1d90-63c7-4a52-9b0f-1d2c3e4f5a6b","eventId":"4e8b1d90-63c7-4a52-9b0f-1d2c3e4f5a6b","event":"post.sent","status":"pending","attempts":0,"createdAt":"2026-08-26T09:24:12.004Z","nextAttemptAt":"2026-08-26T09:24:12.004Z","deliveredAt":null,"deadAt":null,"lastStatusCode":null,"lastError":null}}`)

	response, err := newClient(stub).SendTestEvent(context.Background(), "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90")
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "POST" {
		t.Errorf("method: got %q, want %q", request.method, "POST")
	}

	if request.url != "/api/v2/webhooks/2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90/test" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/webhooks/2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90/test")
	}

	want := SendWebhookTestEventResponse{
		Delivery: WebhookDelivery{
			ID:            "4e8b1d90-63c7-4a52-9b0f-1d2c3e4f5a6b",
			EventID:       "4e8b1d90-63c7-4a52-9b0f-1d2c3e4f5a6b",
			Event:         EventPostSent,
			Status:        DeliveryStatusPending,
			Attempts:      0,
			CreatedAt:     "2026-08-26T09:24:12.004Z",
			NextAttemptAt: "2026-08-26T09:24:12.004Z",
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestGetHealthReadsTheChecksBehindTheStatus(t *testing.T) {
	stub := newJSONStub(t, 200, `{"status":"degraded","checks":{"database":{"ok":true,"latencyMs":3},"scheduledPosts":{"ok":false,"lastRunAt":"2026-08-29T11:04:58.120Z","lastOkAt":null},"webhookDeliveries":{"ok":true,"lastRunAt":"2026-08-29T11:04:57.870Z","lastOkAt":"2026-08-29T11:04:57.870Z"},"xUsageSweep":{"ok":true,"lastRunAt":"2026-08-29T11:04:31.004Z","lastOkAt":"2026-08-29T11:04:31.004Z"}},"version":"2.0.0","time":"2026-08-29T11:05:00.512Z"}`)

	response, err := newClient(stub).GetHealth(context.Background())
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "GET" {
		t.Errorf("method: got %q, want %q", request.method, "GET")
	}

	if request.url != "/api/v2/health" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/health")
	}

	want := GetHealthResponse{
		Status:  HealthStatusDegraded,
		Version: "2.0.0",
		Time:    "2026-08-29T11:05:00.512Z",
	}
	want.Checks.Database = HealthDatabaseCheck{OK: true, LatencyMs: 3}
	want.Checks.ScheduledPosts = HealthWorkerCheck{OK: false, LastRunAt: stringPointer("2026-08-29T11:04:58.120Z"), LastOkAt: nil}
	want.Checks.WebhookDeliveries = HealthWorkerCheck{OK: true, LastRunAt: stringPointer("2026-08-29T11:04:57.870Z"), LastOkAt: stringPointer("2026-08-29T11:04:57.870Z")}
	want.Checks.XUsageSweep = HealthWorkerCheck{OK: true, LastRunAt: stringPointer("2026-08-29T11:04:31.004Z"), LastOkAt: stringPointer("2026-08-29T11:04:31.004Z")}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestGetHealthNeedsNoApiKey(t *testing.T) {
	stub := newJSONStub(t, 200, `{"status":"ok","checks":{"database":{"ok":true,"latencyMs":3},"scheduledPosts":{"ok":true,"lastRunAt":null,"lastOkAt":null},"webhookDeliveries":{"ok":true,"lastRunAt":null,"lastOkAt":null},"xUsageSweep":{"ok":true,"lastRunAt":null,"lastOkAt":null}},"version":"2.0.0","time":"2026-08-29T11:05:00.512Z"}`)

	response, err := New("", WithBaseURL(stub.server.URL+"/api/v2")).GetHealth(context.Background())
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if _, hasHeader := request.headers["X-Api-Key"]; hasHeader {
		t.Errorf("x-api-key: got %q, want no header at all", request.headers.Get("x-api-key"))
	}

	if response.Status != HealthStatusOK {
		t.Errorf("status: got %q, want %q", response.Status, HealthStatusOK)
	}
}

func TestGetHealthHistoryPutsTheWindowInTheQueryString(t *testing.T) {
	stub := newJSONStub(t, 200, `{"days":[{"day":"2026-08-27","uptimePercent":null,"samples":0,"degradedMinutes":0},{"day":"2026-08-28","uptimePercent":100,"samples":1440,"degradedMinutes":0},{"day":"2026-08-29","uptimePercent":99.72,"samples":718,"degradedMinutes":2}]}`)

	response, err := newClient(stub).GetHealthHistory(context.Background(), GetHealthHistoryParams{Days: 3})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.url != "/api/v2/health/history?days=3" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/health/history?days=3")
	}

	want := GetHealthHistoryResponse{
		Days: []HealthDay{
			{Day: "2026-08-27", UptimePercent: nil, Samples: 0, DegradedMinutes: 0},
			{Day: "2026-08-28", UptimePercent: floatPointer(100), Samples: 1440, DegradedMinutes: 0},
			{Day: "2026-08-29", UptimePercent: floatPointer(99.72), Samples: 718, DegradedMinutes: 2},
		},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestGetHealthHistorySendsNoQueryStringWithoutAWindow(t *testing.T) {
	stub := newJSONStub(t, 200, `{"days":[]}`)

	_, err := newClient(stub).GetHealthHistory(context.Background(), GetHealthHistoryParams{})
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.url != "/api/v2/health/history" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/health/history")
	}
}

func TestGetStatsReadsThePublicCountsWithoutAnApiKey(t *testing.T) {
	stub := newJSONStub(t, 200, `{"postsThisWeek":100,"postsAllTime":1000,"liveConnections":10,"platformsLive":["linkedin","x","bluesky","mastodon","reddit","google_business"],"time":"2026-09-06T11:05:00.512Z"}`)

	response, err := New("", WithBaseURL(stub.server.URL+"/api/v2")).GetStats(context.Background())
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "GET" {
		t.Errorf("method: got %q, want %q", request.method, "GET")
	}

	if request.url != "/api/v2/stats" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/stats")
	}

	if _, hasHeader := request.headers["X-Api-Key"]; hasHeader {
		t.Errorf("x-api-key: got %q, want no header at all", request.headers.Get("x-api-key"))
	}

	want := GetStatsResponse{
		PostsThisWeek:   100,
		PostsAllTime:    1000,
		LiveConnections: 10,
		PlatformsLive:   []string{"linkedin", "x", "bluesky", "mastodon", "reddit", "google_business"},
		Time:            "2026-09-06T11:05:00.512Z",
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestGetOpenapiSpecReadsTheDocumentWithoutAnApiKey(t *testing.T) {
	stub := newJSONStub(t, 200, `{"openapi":"3.1.0","info":{"title":"yeetpost API","version":"2.0.0"}}`)

	response, err := New("", WithBaseURL(stub.server.URL+"/api/v2")).GetOpenapiSpec(context.Background())
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.method != "GET" {
		t.Errorf("method: got %q, want %q", request.method, "GET")
	}

	if request.url != "/api/v2/openapi.json" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/openapi.json")
	}

	if _, hasHeader := request.headers["X-Api-Key"]; hasHeader {
		t.Errorf("x-api-key: got %q, want no header at all", request.headers.Get("x-api-key"))
	}

	want := GetOpenapiSpecResponse{
		"openapi": "3.1.0",
		"info":    map[string]any{"title": "yeetpost API", "version": "2.0.0"},
	}

	if !reflect.DeepEqual(response, want) {
		t.Errorf("response: got %+v, want %+v", response, want)
	}
}

func TestWithBaseUrlDropsATrailingSlash(t *testing.T) {
	stub := newJSONStub(t, 200, `{"connections":[]}`)

	client := New("yp_secret_test", WithBaseURL(stub.server.URL+"/api/v2/"))

	if _, err := client.ListConnections(context.Background(), nil); err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	request := onlyRequest(t, stub)

	if request.url != "/api/v2/connections" {
		t.Errorf("url: got %q, want %q", request.url, "/api/v2/connections")
	}
}

// recordingTransport counts the requests that went through the http client it
// belongs to, and otherwise sends them normally.
type recordingTransport struct {
	requests int
}

func (transport *recordingTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	transport.requests++

	return http.DefaultTransport.RoundTrip(request)
}

func TestWithHttpClientIsTheClientThatSendsTheRequest(t *testing.T) {
	stub := newJSONStub(t, 200, `{"connections":[]}`)

	transport := &recordingTransport{}
	httpClient := &http.Client{Timeout: time.Second, Transport: transport}
	client := New("yp_secret_test", WithBaseURL(stub.server.URL+"/api/v2"), WithHTTPClient(httpClient))

	if _, err := client.ListConnections(context.Background(), nil); err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	// The given client's own transport carried the call, so the option is what
	// sends the request rather than only what is stored on the client.
	if transport.requests != 1 {
		t.Errorf("requests through the given client: got %d, want 1", transport.requests)
	}
}

func TestACancelledContextStopsTheCall(t *testing.T) {
	stub := newJSONStub(t, 200, `{"connections":[]}`)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := newClient(stub).ListConnections(ctx, nil)

	if !errors.Is(err, context.Canceled) {
		t.Errorf("err: got %v, want context.Canceled", err)
	}
}

//
// Errors
//

func TestAnErrorResponseBecomesAnApiErrorWithItsCode(t *testing.T) {
	stub := newJSONStub(t, 400, `{"error":"invalid_connection","message":"Connection 'linkedn' not found. Available connections: linkedin, x"}`)
	stub.extraHeaders["x-ratelimit-limit"] = "60"
	stub.extraHeaders["x-ratelimit-remaining"] = "58"
	stub.extraHeaders["x-ratelimit-reset"] = "1787851260"

	_, err := newClient(stub).CreatePosts(context.Background(), CreatePostsParams{
		Text:            "hello",
		ConnectionSlugs: []string{"linkedn"},
	})

	var apiError *APIError

	if !errors.As(err, &apiError) {
		t.Fatalf("err: got %v, want an *APIError", err)
	}

	want := &APIError{
		StatusCode:         400,
		Code:               "invalid_connection",
		Message:            "Connection 'linkedn' not found. Available connections: linkedin, x",
		RequestID:          "",
		RateLimitLimit:     60,
		RateLimitRemaining: 58,
		RateLimitReset:     1787851260,
	}

	if !reflect.DeepEqual(apiError, want) {
		t.Errorf("error: got %+v, want %+v", apiError, want)
	}

	wantMessage := "yeetpost: 400 invalid_connection: Connection 'linkedn' not found. Available connections: linkedin, x"

	if apiError.Error() != wantMessage {
		t.Errorf("error message: got %q, want %q", apiError.Error(), wantMessage)
	}
}

func TestTheRequestIdHeaderIsExposedOnTheError(t *testing.T) {
	stub := newJSONStub(t, 422, `{"error":"platform_rejected","message":"LinkedIn: duplicate post was detected","req_id":"req_12345678"}`)
	stub.extraHeaders["x-request-id"] = "req_12345678"

	_, err := newClient(stub).PostToConnection(context.Background(), "linkedin", "hello", PostToConnectionParams{})

	var apiError *APIError

	if !errors.As(err, &apiError) {
		t.Fatalf("err: got %v, want an *APIError", err)
	}

	want := &APIError{
		StatusCode:         422,
		Code:               "platform_rejected",
		Message:            "LinkedIn: duplicate post was detected",
		RequestID:          "req_12345678",
		RateLimitLimit:     -1,
		RateLimitRemaining: -1,
		RateLimitReset:     -1,
	}

	if !reflect.DeepEqual(apiError, want) {
		t.Errorf("error: got %+v, want %+v", apiError, want)
	}
}

func TestReqIdInTheBodyIsExposedWhenTheHeaderIsMissing(t *testing.T) {
	stub := newJSONStub(t, 500, `{"error":"internal_server_error","message":"An unexpected error occurred","req_id":"req_48120533"}`)

	_, err := newClient(stub).ListConnections(context.Background(), nil)

	var apiError *APIError

	if !errors.As(err, &apiError) {
		t.Fatalf("err: got %v, want an *APIError", err)
	}

	if apiError.RequestID != "req_48120533" {
		t.Errorf("requestId: got %q, want %q", apiError.RequestID, "req_48120533")
	}
}

func TestThe429BodyWhichHasNoMessageStillBecomesAnApiError(t *testing.T) {
	stub := newJSONStub(t, 429, `{"error":"too many requests"}`)
	stub.extraHeaders["x-ratelimit-limit"] = "60"
	stub.extraHeaders["x-ratelimit-remaining"] = "0"
	stub.extraHeaders["x-ratelimit-reset"] = "1787851260"

	_, err := newClient(stub).ListPosts(context.Background(), ListPostsParams{})

	var apiError *APIError

	if !errors.As(err, &apiError) {
		t.Fatalf("err: got %v, want an *APIError", err)
	}

	want := &APIError{
		StatusCode:         429,
		Code:               "too many requests",
		Message:            "too many requests",
		RequestID:          "",
		RateLimitLimit:     60,
		RateLimitRemaining: 0,
		RateLimitReset:     1787851260,
	}

	if !reflect.DeepEqual(apiError, want) {
		t.Errorf("error: got %+v, want %+v", apiError, want)
	}
}

func TestAnErrorBodyThatIsNotJsonStillBecomesAnApiError(t *testing.T) {
	stub := newStubServer(t, 502, "text/html", "<html>bad gateway</html>")

	_, err := newClient(stub).ListConnections(context.Background(), nil)

	var apiError *APIError

	if !errors.As(err, &apiError) {
		t.Fatalf("err: got %v, want an *APIError", err)
	}

	want := &APIError{
		StatusCode:         502,
		Code:               "internal_server_error",
		Message:            "the yeetpost api returned an error that was not json",
		RequestID:          "",
		RateLimitLimit:     -1,
		RateLimitRemaining: -1,
		RateLimitReset:     -1,
	}

	if !reflect.DeepEqual(apiError, want) {
		t.Errorf("error: got %+v, want %+v", apiError, want)
	}
}

func TestAnErrorBodyWithoutACodeStillBecomesAnApiError(t *testing.T) {
	stub := newJSONStub(t, 503, `{"message":"we are down"}`)

	_, err := newClient(stub).ListConnections(context.Background(), nil)

	var apiError *APIError

	if !errors.As(err, &apiError) {
		t.Fatalf("err: got %v, want an *APIError", err)
	}

	if apiError.Code != "internal_server_error" {
		t.Errorf("code: got %q, want %q", apiError.Code, "internal_server_error")
	}

	if apiError.Message != "the yeetpost api returned an error without a code" {
		t.Errorf("message: got %q, want %q", apiError.Message, "the yeetpost api returned an error without a code")
	}
}

// A bare null parses as json but is not an error body at all, which is the
// reading the node and python clients give it too.
func TestAnErrorBodyThatIsJsonNullIsReadAsNotJson(t *testing.T) {
	stub := newJSONStub(t, 503, `null`)

	_, err := newClient(stub).ListConnections(context.Background(), nil)

	var apiError *APIError

	if !errors.As(err, &apiError) {
		t.Fatalf("err: got %v, want an *APIError", err)
	}

	if apiError.Code != "internal_server_error" {
		t.Errorf("code: got %q, want %q", apiError.Code, "internal_server_error")
	}

	if apiError.Message != "the yeetpost api returned an error that was not json" {
		t.Errorf("message: got %q, want %q", apiError.Message, "the yeetpost api returned an error that was not json")
	}
}

// An array is an object with no code on it, which is again what the node and
// python clients read it as.
func TestAnErrorBodyThatIsAJsonArrayIsReadAsWithoutACode(t *testing.T) {
	stub := newJSONStub(t, 503, `[]`)

	_, err := newClient(stub).ListConnections(context.Background(), nil)

	var apiError *APIError

	if !errors.As(err, &apiError) {
		t.Fatalf("err: got %v, want an *APIError", err)
	}

	if apiError.Code != "internal_server_error" {
		t.Errorf("code: got %q, want %q", apiError.Code, "internal_server_error")
	}

	if apiError.Message != "the yeetpost api returned an error without a code" {
		t.Errorf("message: got %q, want %q", apiError.Message, "the yeetpost api returned an error without a code")
	}
}

func TestASuccessBodyThatIsNotJsonBecomesAnApiError(t *testing.T) {
	stub := newStubServer(t, 200, "text/html", "<html>hello</html>")

	_, err := newClient(stub).ListConnections(context.Background(), nil)

	var apiError *APIError

	if !errors.As(err, &apiError) {
		t.Fatalf("err: got %v, want an *APIError", err)
	}

	if apiError.StatusCode != 200 {
		t.Errorf("statusCode: got %d, want 200", apiError.StatusCode)
	}

	if apiError.Message != "the yeetpost api returned a response that was not json" {
		t.Errorf("message: got %q, want %q", apiError.Message, "the yeetpost api returned a response that was not json")
	}
}

//
// Webhook signatures
//

// The fixture is the one the node sdk's test uses, so the two clients agree on
// the bytes that get signed.
const webhookSecret = "yp_whsec_3f1a"

const webhookBody = `{"event":"post.sent","timestamp":"2026-08-26T09:24:12.004Z"}`

func getSignatureHeader(body string, timestampSeconds int64) string {
	mac := hmac.New(sha256.New, []byte(webhookSecret))
	mac.Write([]byte(strconv.FormatInt(timestampSeconds, 10) + "." + body))

	return "t=" + strconv.FormatInt(timestampSeconds, 10) + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

func TestAValidSignatureVerifies(t *testing.T) {
	header := getSignatureHeader(webhookBody, time.Now().Unix())

	isValid, err := VerifyWebhookSignature(webhookSecret, header, []byte(webhookBody), DefaultWebhookTolerance)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	if !isValid {
		t.Errorf("isValid: got false, want true")
	}
}

// A vector computed by the node sdk's own hmac, so a signature this client
// accepts is one that client accepts too. The timestamp is fixed, so it needs a
// tolerance wide enough to reach it.
func TestTheNodeSdkVectorVerifies(t *testing.T) {
	header := "t=1787653452,v1=f1d967b462aab2a3e8bf662c933d9e2181dc0a09271f22e27076c509c791c9b3"
	tolerance := 100 * 365 * 24 * time.Hour

	isValid, err := VerifyWebhookSignature(webhookSecret, header, []byte(webhookBody), tolerance)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	if !isValid {
		t.Errorf("isValid: got false, want true")
	}
}

func TestATamperedBodyDoesNotVerify(t *testing.T) {
	header := getSignatureHeader(webhookBody, time.Now().Unix())

	isValid, err := VerifyWebhookSignature(webhookSecret, header, []byte(webhookBody+" "), DefaultWebhookTolerance)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	if isValid {
		t.Errorf("isValid: got true, want false")
	}
}

func TestTheWrongSecretDoesNotVerify(t *testing.T) {
	header := getSignatureHeader(webhookBody, time.Now().Unix())

	isValid, err := VerifyWebhookSignature("yp_whsec_someoneelse", header, []byte(webhookBody), DefaultWebhookTolerance)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	if isValid {
		t.Errorf("isValid: got true, want false")
	}
}

func TestAnExpiredTimestampDoesNotVerify(t *testing.T) {
	header := getSignatureHeader(webhookBody, time.Now().Unix()-400)

	isValid, err := VerifyWebhookSignature(webhookSecret, header, []byte(webhookBody), DefaultWebhookTolerance)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	if isValid {
		t.Errorf("isValid: got true, want false")
	}
}

func TestAnExpiredTimestampVerifiesWithAWiderTolerance(t *testing.T) {
	header := getSignatureHeader(webhookBody, time.Now().Unix()-400)

	isValid, err := VerifyWebhookSignature(webhookSecret, header, []byte(webhookBody), 10*time.Minute)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	if !isValid {
		t.Errorf("isValid: got false, want true")
	}
}

func TestAToleranceOfZeroFallsBackToTheDefault(t *testing.T) {
	header := getSignatureHeader(webhookBody, time.Now().Unix())

	isValid, err := VerifyWebhookSignature(webhookSecret, header, []byte(webhookBody), 0)
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	if !isValid {
		t.Errorf("isValid: got false, want true")
	}
}

func TestAMalformedSignatureHeaderIsAnError(t *testing.T) {
	isValid, err := VerifyWebhookSignature(webhookSecret, "v1=deadbeef", []byte(webhookBody), DefaultWebhookTolerance)

	if !errors.Is(err, ErrMalformedSignature) {
		t.Errorf("err: got %v, want ErrMalformedSignature", err)
	}

	if isValid {
		t.Errorf("isValid: got true, want false")
	}
}

func TestParseWebhookEventReadsTheDeliveryBody(t *testing.T) {
	body := `{"eventId":"8d3f2b7c-4e1a-4c6d-9b0f-1a2b3c4d5e6f","event":"post.sent","timestamp":"2026-08-26T09:24:12.004Z","test":true,"post":{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","connectionSlug":"linkedin","text":"shipped the new api docs today","status":"sent","url":"https://www.linkedin.com/feed/update/urn:li:share:1234567890","scheduledFor":null,"createdAt":"2026-08-26T09:24:11.412Z","tags":["launch"],"mediaCount":1,"threadCount":0,"hasFirstComment":false,"error":null}}`

	event, err := ParseWebhookEvent([]byte(body))
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	want := Event{
		EventID:   "8d3f2b7c-4e1a-4c6d-9b0f-1a2b3c4d5e6f",
		Event:     EventPostSent,
		Timestamp: "2026-08-26T09:24:12.004Z",
		Test:      true,
		Post: EventPost{
			ID:              "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
			ConnectionSlug:  "linkedin",
			Text:            "shipped the new api docs today",
			Status:          PostStatusSent,
			URL:             stringPointer("https://www.linkedin.com/feed/update/urn:li:share:1234567890"),
			ScheduledFor:    nil,
			CreatedAt:       "2026-08-26T09:24:11.412Z",
			Tags:            []string{"launch"},
			MediaCount:      1,
			ThreadCount:     0,
			HasFirstComment: false,
			Error:           nil,
		},
	}

	if !reflect.DeepEqual(event, want) {
		t.Errorf("event: got %+v, want %+v", event, want)
	}
}

func TestParsePostDeletedWebhookEventReadsTheDeliveryBody(t *testing.T) {
	body := `{"eventId":"2b7c8d3f-4e1a-4c6d-9b0f-1a2b3c4d5e6f","event":"post.deleted","timestamp":"2026-08-29T11:02:44.204Z","post":{"id":"6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10","connectionSlug":"linkedin","platformId":"linkedin","deletedAt":"2026-08-29T11:02:44.108Z"}}`

	event, err := ParsePostDeletedWebhookEvent([]byte(body))
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	want := PostDeletedEvent{
		EventID:   "2b7c8d3f-4e1a-4c6d-9b0f-1a2b3c4d5e6f",
		Event:     EventPostDeleted,
		Timestamp: "2026-08-29T11:02:44.204Z",
		Post: DeletedEventPost{
			ID:             "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
			ConnectionSlug: "linkedin",
			PlatformID:     "linkedin",
			DeletedAt:      "2026-08-29T11:02:44.108Z",
		},
	}

	if !reflect.DeepEqual(event, want) {
		t.Errorf("event: got %+v, want %+v", event, want)
	}
}

func TestParseConnectionWebhookEventReadsTheDeliveryBody(t *testing.T) {
	body := `{"eventId":"1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f","event":"connection.created","timestamp":"2026-08-29T09:24:12.004Z","connection":{"id":"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b","profileId":"b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b","connectSessionId":"7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f","platformId":"linkedin","slug":"acme_linkedin"}}`

	event, err := ParseConnectionWebhookEvent([]byte(body))
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	want := ConnectionEvent{
		EventID:   "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
		Event:     ConnectionEventNameCreated,
		Timestamp: "2026-08-29T09:24:12.004Z",
		Connection: EventConnection{
			ID:        "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
			ProfileID: stringPointer("b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b"),
			// The session the account came in through, so the connection can be
			// filed against the customer the link was made for without waiting
			// for a browser
			ConnectSessionID: stringPointer("7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f"),
			PlatformID:       "linkedin",
			Slug:             "acme_linkedin",
		},
	}

	if !reflect.DeepEqual(event, want) {
		t.Errorf("event: got %+v, want %+v", event, want)
	}
}

func TestParseConnectionWebhookEventReadsOneOfYourOwnAccounts(t *testing.T) {
	body := `{"eventId":"1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f","event":"connection.removed","timestamp":"2026-08-29T09:24:12.004Z","connection":{"id":"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b","profileId":null,"connectSessionId":null,"platformId":"linkedin","slug":"linkedin"}}`

	event, err := ParseConnectionWebhookEvent([]byte(body))
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	if event.Event != ConnectionEventNameRemoved {
		t.Errorf("event: got %q, want %q", event.Event, ConnectionEventNameRemoved)
	}

	if event.Connection.ProfileID != nil {
		t.Errorf("profileId: got %q, want nil", *event.Connection.ProfileID)
	}

	// One of your own accounts, connected in the console rather than through a
	// connect link
	if event.Connection.ConnectSessionID != nil {
		t.Errorf("connectSessionId: got %q, want nil", *event.Connection.ConnectSessionID)
	}
}

func TestParseConnectionWebhookEventReadsAReconnectRequired(t *testing.T) {
	body := `{"eventId":"1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f","event":"connection.reconnect_required","timestamp":"2026-08-29T09:24:12.004Z","connection":{"id":"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b","profileId":null,"connectSessionId":null,"platformId":"linkedin","slug":"linkedin"}}`

	event, err := ParseConnectionWebhookEvent([]byte(body))
	if err != nil {
		t.Fatalf("err: got %v, want nil", err)
	}

	if event.Event != ConnectionEventNameReconnectRequired {
		t.Errorf("event: got %q, want %q", event.Event, ConnectionEventNameReconnectRequired)
	}
}

func TestParseConnectionWebhookEventRefusesABodyThatIsNotJson(t *testing.T) {
	_, err := ParseConnectionWebhookEvent([]byte("<html>not an event</html>"))

	if err == nil {
		t.Fatalf("err: got nil, want an error")
	}

	var syntaxError *json.SyntaxError

	if !errors.As(err, &syntaxError) {
		t.Errorf("err: got %v, want a wrapped json error", err)
	}
}

func TestParsePostDeletedWebhookEventRefusesABodyThatIsNotJson(t *testing.T) {
	_, err := ParsePostDeletedWebhookEvent([]byte("<html>not an event</html>"))

	if err == nil {
		t.Fatalf("err: got nil, want an error")
	}

	var syntaxError *json.SyntaxError

	if !errors.As(err, &syntaxError) {
		t.Errorf("err: got %v, want a wrapped json error", err)
	}
}

func TestParseWebhookEventRefusesABodyThatIsNotJson(t *testing.T) {
	_, err := ParseWebhookEvent([]byte("<html>not an event</html>"))

	if err == nil {
		t.Fatalf("err: got nil, want an error")
	}

	var syntaxError *json.SyntaxError

	if !errors.As(err, &syntaxError) {
		t.Errorf("err: got %v, want a wrapped json error", err)
	}
}
