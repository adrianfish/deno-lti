## LTI Advantage Assignment and Grades Service (AGS)

AGS is one of the three core **LTI Advantage** services (alongside Names and Roles Provisioning and Deep Linking). It gives tools the ability to create gradebook columns ("line items") in the platform and push scores back, replacing the old Basic Outcomes Service from LTI 1.1.

---

## Core Concepts

### Line Items
A **line item** represents a gradebook column. It has:
- `id` — a URL that acts as the unique identifier
- `label` — display name
- `scoreMaximum` — the max points
- `resourceId` / `resourceLinkId` — optional associations back to a content item or launch
- `tag` — optional free-form categorisation
- `startDateTime` / `endDateTime` — optional availability window

### Scores
A **score** is a result submission posted to a line item. Key fields:
- `userId` — the `sub` from the LTI launch JWT
- `scoreGiven` / `scoreMaximum`
- `activityProgress` — `Initialized`, `Started`, `InProgress`, `Submitted`, `Completed`
- `gradingProgress` — `NotReady`, `Failed`, `Pending`, `PendingManual`, `FullyGraded`
- `timestamp` — ISO 8601

A score is only treated as a final grade when `gradingProgress` is `FullyGraded`. The platform won't necessarily show a grade until that's set.

### Results
A **result** is the platform's stored record of a score — it's what you *read back* after posting. Results are read-only from the tool side.

---

## The Flow

```
LTI Launch JWT
  └─ claim: https://purl.imsglobal.org/spec/lti-ags/claim/endpoint
       ├─ scope       → what the tool is allowed to do
       ├─ lineitems   → URL to the line items container (may be absent)
       └─ lineitem    → URL to a pre-associated line item (if platform created one)
```

**1. Parse the AGS claim from the launch JWT:**
```json
{
  "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint": {
    "scope": [
      "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
      "https://purl.imsglobal.org/spec/lti-ags/scope/score"
    ],
    "lineitems": "https://platform.example.com/api/lti/courses/42/lineitems",
    "lineitem": "https://platform.example.com/api/lti/courses/42/lineitems/99"
  }
}
```

**2. Get an access token** via the LTI Client Credentials flow (OAuth 2 with a signed JWT assertion), requesting only the scopes you need.

**3. Manage line items** (if you have `lineitem` scope):
```
GET    {lineitems}          → list all line items
POST   {lineitems}          → create a new line item
GET    {lineitem}           → get one line item
PUT    {lineitem}           → update a line item
DELETE {lineitem}           → delete a line item
```

**4. Post a score** (if you have `score` scope):
```
POST {lineitem}/scores
Content-Type: application/vnd.ims.lis.v1.score+json

{
  "userId": "a1b2c3",
  "scoreGiven": 85,
  "scoreMaximum": 100,
  "activityProgress": "Completed",
  "gradingProgress": "FullyGraded",
  "timestamp": "2026-05-13T10:00:00Z"
}
```

**5. Read results back** (if you have `result` scope):
```
GET {lineitem}/results
GET {lineitem}/results?user_id={userId}
```

---

## Scopes Breakdown

| Scope | What it unlocks |
|---|---|
| `lineitem` | Full CRUD on line items |
| `lineitem.readonly` | Read line items only |
| `score` | Post scores to a line item |
| `result.readonly` | Read results |

Platforms advertise which scopes they support — you should only request what you actually need, and handle graceful degradation when a scope isn't granted.

---

## Does AGS Have to Be Implemented Alongside Deep Linking?

**No — they are independent.** They solve different problems:

- **Deep Linking (LTI-DL)** is about a teacher *selecting content* and embedding it in the course. It happens at content-selection time.
- **AGS** is about a student *completing an activity* and the tool reporting a grade back. It happens at runtime/launch time.

They are often used *together* in practice because a common pattern is:

1. Teacher uses Deep Linking to place a graded activity in the course
2. Platform creates a resource link and optionally a line item for it
3. When a student launches that link, the JWT contains the AGS endpoint claim
4. Tool uses AGS to post the student's score

But each is independently optional:
- You can use AGS **without Deep Linking** — e.g. the platform creates assignments natively and includes the AGS claim in regular resource link launches.
- You can use Deep Linking **without AGS** — e.g. embedding non-graded content like videos or reference pages.

The one thing that *does* connect them is the `resourceLinkId` on a line item — if you created a content item via Deep Linking, you can associate the resulting line item back to that link ID, which helps platforms tie the gradebook column to the right assignment. But that's an optional association, not a requirement.

---

## Things to Watch Out For in Your Implementation

- **`lineitem` vs `lineitems`** — if only `lineitem` (singular) is present in the claim, the platform pre-created the column and you should use that URL directly rather than creating your own. Creating a duplicate line item in this case is a common mistake.
- **Token caching** — access tokens from the client credentials flow are short-lived (typically 1 hour). Cache them per deployment/scope set rather than requesting a new one per API call.
- **Score idempotency** — posting a score twice with the same `userId` and `timestamp` is not guaranteed to be idempotent across platforms. Use a consistent timestamp tied to the submission, not the current time.
- **`gradingProgress` must be `FullyGraded`** for Canvas (and most platforms) to actually record the grade in the gradebook. `Pending` scores are often silently accepted but not displayed.
- **Content-Type headers matter** — line items use `application/vnd.ims.lis.v2.lineitem+json`, scores use `application/vnd.ims.lis.v1.score+json`. Getting these wrong causes cryptic 400/415 errors on strict platforms.
