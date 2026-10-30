// Package yeetpost is a client for the yeetpost API: post to LinkedIn, X,
// Bluesky, Discord, Telegram and Mastodon from one HTTP call.
//
// It is hand-written against yeetpost-api/src/lib/openapi.json and uses nothing
// outside the standard library. The response structs are copies of the schemas
// in that spec, so they stay portable and self-contained.
//
// One client per API key. Every call takes a context and every non-2xx comes
// back as an *APIError:
//
//	client := yeetpost.New(os.Getenv("YEETPOST_API_KEY"))
//
//	response, err := client.CreatePosts(ctx, yeetpost.CreatePostsParams{
//		Text:            "shipped the new api docs today",
//		ConnectionSlugs: []string{"linkedin", "x"},
//	})
//
// CreatePosts fans one post out over several connections, so one connection
// failing does not fail the call. Read the per-item status:
//
//	for _, result := range response.Results.Failed() {
//		log.Println(result.ConnectionSlug, result.Error.Code, result.Error.Message)
//	}
//
// If you are posting on behalf of your own customers rather than to your own
// accounts, CreateProfile makes one profile per customer and CreatePostsParams
// takes its ProfileID. A post that names a profile can only reach that
// profile's connections, and a post that names none can only reach your own.
// CreateConnectURL is the page you send a customer to so they can connect one
// of their own accounts into their profile, and ParseConnectRedirect reads the
// query they land back on.
//
// On the receiving end, VerifyWebhookSignature checks a delivery against the
// raw body before ParseWebhookEvent turns it into an Event.
package yeetpost
