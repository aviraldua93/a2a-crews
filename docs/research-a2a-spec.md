Agent completed. agent_id: a2a-spec-expert, agent_type: explore, status: completed, description: Study official A2A proto spec, elapsed: 81s, total_turns: 0, duration: 81s

Perfect! Now I have the complete proto file. Let me compile this into a comprehensive TypeScript interface reference:

## A2A Protocol - Complete TypeScript Interface Reference

Based on the official A2A specification (v1), here's the authoritative type definition for `src/a2a/types.ts`:

```typescript
// ============================================================================
// ENUMS
// ============================================================================

/**
 * Defines the possible lifecycle states of a Task.
 */
export enum TaskState {
  /** The task is in an unknown or indeterminate state. */
  UNSPECIFIED = 0,
  /** Indicates that a task has been successfully submitted and acknowledged. */
  SUBMITTED = 1,
  /** Indicates that a task is actively being processed by the agent. */
  WORKING = 2,
  /** Indicates that a task has finished successfully. TERMINAL STATE. */
  COMPLETED = 3,
  /** Indicates that a task has finished with an error. TERMINAL STATE. */
  FAILED = 4,
  /** Indicates that a task was canceled before completion. TERMINAL STATE. */
  CANCELED = 5,
  /** Indicates that the agent requires additional user input to proceed. INTERRUPTED STATE. */
  INPUT_REQUIRED = 6,
  /** Indicates that the agent has decided to not perform the task. TERMINAL STATE. */
  REJECTED = 7,
  /** Indicates that authentication is required to proceed. INTERRUPTED STATE. */
  AUTH_REQUIRED = 8,
}

/**
 * Defines the sender of a message in A2A protocol communication.
 */
export enum Role {
  /** The role is unspecified. */
  UNSPECIFIED = 0,
  /** The message is from the client to the server. */
  USER = 1,
  /** The message is from the server to the client. */
  AGENT = 2,
}

// ============================================================================
// CORE MESSAGE TYPES
// ============================================================================

/**
 * `Part` represents a container for a section of communication content.
 * Parts can be textual, files (image, video, etc), or structured data blobs (JSON).
 */
export interface Part {
  /** One of the following: text, raw, url, or data */
  content: {
    /** The string content of the text part. */
    text?: string;
    /** The raw byte content of a file. In JSON serialization, base64 string. */
    raw?: Uint8Array;
    /** A URL pointing to the file's content. */
    url?: string;
    /** Arbitrary structured data as a JSON value (object, array, string, number, boolean, or null). */
    data?: any; // google.protobuf.Value
  };
  /** Optional. Metadata associated with this part. */
  metadata?: Record<string, any>; // google.protobuf.Struct
  /** An optional filename for the file (e.g., "document.pdf"). */
  filename?: string;
  /** The media_type (MIME type) of the part content (e.g., "text/plain", "application/json", "image/png"). */
  mediaType?: string;
}

/**
 * `Message` is one unit of communication between client and server.
 * Can be associated with a context and/or a task.
 */
export interface Message {
  /** REQUIRED. The unique identifier (e.g. UUID) of the message. Created by the message creator. */
  messageId: string;
  /** Optional. The context id of the message. If set, associates message with the given context. */
  contextId?: string;
  /** Optional. The task id of the message. If set, associates message with the given task. */
  taskId?: string;
  /** REQUIRED. Identifies the sender of the message. */
  role: Role;
  /** REQUIRED. Parts is the container of the message content. */
  parts: Part[];
  /** Optional. Any metadata to provide along with the message. */
  metadata?: Record<string, any>; // google.protobuf.Struct
  /** The URIs of extensions that are present or contributed to this Message. */
  extensions?: string[];
  /** A list of task IDs that this message references for additional context. */
  referenceTaskIds?: string[];
}

/**
 * Artifacts represent task outputs.
 */
export interface Artifact {
  /** REQUIRED. Unique identifier (e.g. UUID) for the artifact. Must be unique within a task. */
  artifactId: string;
  /** A human readable name for the artifact. */
  name?: string;
  /** Optional. A human readable description of the artifact. */
  description?: string;
  /** REQUIRED. The content of the artifact. Must contain at least one part. */
  parts: Part[];
  /** Optional. Metadata included with the artifact. */
  metadata?: Record<string, any>; // google.protobuf.Struct
  /** The URIs of extensions that are present or contributed to this Artifact. */
  extensions?: string[];
}

/**
 * A container for the status of a task.
 */
export interface TaskStatus {
  /** REQUIRED. The current state of this task. */
  state: TaskState;
  /** A message associated with the status. */
  message?: Message;
  /** ISO 8601 Timestamp when the status was recorded. Example: "2023-10-27T10:00:00Z" */
  timestamp?: Date; // google.protobuf.Timestamp
}

/**
 * `Task` is the core unit of action for A2A.
 * It has a current status and results are stored in the artifact.
 * Multiple turns are stored in history.
 */
export interface Task {
  /** REQUIRED. Unique identifier (e.g. UUID) for the task, generated by the server for a new task. */
  id: string;
  /** Unique identifier (e.g. UUID) for the contextual collection of interactions (tasks and messages). */
  contextId?: string;
  /** REQUIRED. The current status of a Task, including state and a message. */
  status: TaskStatus;
  /** A set of output artifacts for a Task. */
  artifacts?: Artifact[];
  /** The history of interactions from a Task. */
  history?: Message[];
  /** A key/value object to store custom metadata about a task. */
  metadata?: Record<string, any>; // google.protobuf.Struct
}

// ============================================================================
// EVENT TYPES
// ============================================================================

/**
 * An event sent by the agent to notify the client of a change in a task's status.
 */
export interface TaskStatusUpdateEvent {
  /** REQUIRED. The ID of the task that has changed. */
  taskId: string;
  /** REQUIRED. The ID of the context that the task belongs to. */
  contextId: string;
  /** REQUIRED. The new status of the task. */
  status: TaskStatus;
  /** Optional. Metadata associated with the task update. */
  metadata?: Record<string, any>; // google.protobuf.Struct
}

/**
 * A task delta where an artifact has been generated.
 */
export interface TaskArtifactUpdateEvent {
  /** REQUIRED. The ID of the task for this artifact. */
  taskId: string;
  /** REQUIRED. The ID of the context that this task belongs to. */
  contextId: string;
  /** REQUIRED. The artifact that was generated or updated. */
  artifact: Artifact;
  /** If true, the content of this artifact should be appended to a previously sent artifact with the same ID. */
  append?: boolean;
  /** If true, this is the final chunk of the artifact. */
  lastChunk?: boolean;
  /** Optional. Metadata associated with the artifact update. */
  metadata?: Record<string, any>; // google.protobuf.Struct
}

// ============================================================================
// AGENT CARD & METADATA TYPES
// ============================================================================

/**
 * Declares a combination of a target URL, transport and protocol version for interacting with the agent.
 * This allows agents to expose the same functionality over multiple protocol binding mechanisms.
 */
export interface AgentInterface {
  /** REQUIRED. The URL where this interface is available. Must be a valid absolute HTTPS URL in production. */
  url: string;
  /** REQUIRED. The protocol binding supported at this URL (e.g., "JSONRPC", "GRPC", "HTTP+JSON"). */
  protocolBinding: string;
  /** Tenant ID to be used in the request when calling the agent. */
  tenant?: string;
  /** REQUIRED. The version of the A2A protocol this interface exposes. Example: "0.3", "1.0" */
  protocolVersion: string;
}

/**
 * Represents the service provider of an agent.
 */
export interface AgentProvider {
  /** REQUIRED. A URL for the agent provider's website or relevant documentation. */
  url: string;
  /** REQUIRED. The name of the agent provider's organization. Example: "Google" */
  organization: string;
}

/**
 * Defines optional capabilities supported by an agent.
 */
export interface AgentCapabilities {
  /** Indicates if the agent supports streaming responses. */
  streaming?: boolean;
  /** Indicates if the agent supports sending push notifications for asynchronous task updates. */
  pushNotifications?: boolean;
  /** A list of protocol extensions supported by the agent. */
  extensions?: AgentExtension[];
  /** Indicates if the agent supports providing an extended agent card when authenticated. */
  extendedAgentCard?: boolean;
}

/**
 * A declaration of a protocol extension supported by an Agent.
 */
export interface AgentExtension {
  /** The unique URI identifying the extension. */
  uri: string;
  /** A human-readable description of how this agent uses the extension. */
  description: string;
  /** If true, the client must understand and comply with the extension's requirements. */
  required: boolean;
  /** Optional. Extension-specific configuration parameters. */
  params?: Record<string, any>; // google.protobuf.Struct
}

/**
 * Represents a distinct capability or function that an agent can perform.
 */
export interface AgentSkill {
  /** REQUIRED. A unique identifier for the agent's skill. */
  id: string;
  /** REQUIRED. A human-readable name for the skill. */
  name: string;
  /** REQUIRED. A detailed description of the skill. */
  description: string;
  /** REQUIRED. A set of keywords describing the skill's capabilities. */
  tags: string[];
  /** Example prompts or scenarios that this skill can handle. */
  examples?: string[];
  /** The set of supported input media types for this skill, overriding the agent's defaults. */
  inputModes?: string[];
  /** The set of supported output media types for this skill, overriding the agent's defaults. */
  outputModes?: string[];
  /** Security schemes necessary for this skill. */
  securityRequirements?: SecurityRequirement[];
}

/**
 * A self-describing manifest for an agent.
 * Provides essential metadata including identity, capabilities, skills, communication methods, and security requirements.
 */
export interface AgentCard {
  /** REQUIRED. A human readable name for the agent. Example: "Recipe Agent" */
  name: string;
  /** REQUIRED. A human-readable description of the agent. */
  description: string;
  /** REQUIRED. Ordered list of supported interfaces. The first entry is preferred. */
  supportedInterfaces: AgentInterface[];
  /** The service provider of the agent. */
  provider?: AgentProvider;
  /** REQUIRED. The version of the agent. Example: "1.0.0" */
  version: string;
  /** A URL providing additional documentation about the agent. */
  documentationUrl?: string;
  /** REQUIRED. A2A Capability set supported by the agent. */
  capabilities: AgentCapabilities;
  /** The security scheme details used for authenticating with this agent. */
  securitySchemes?: Record<string, SecurityScheme>;
  /** Security requirements for contacting the agent. */
  securityRequirements?: SecurityRequirement[];
  /** REQUIRED. The set of interaction modes that the agent supports across all skills. Can be overridden per skill. Defined as media types. */
  defaultInputModes: string[];
  /** REQUIRED. The media types supported as outputs from this agent. */
  defaultOutputModes: string[];
  /** REQUIRED. Skills represent the abilities of an agent. */
  skills: AgentSkill[];
  /** JSON Web Signatures computed for this AgentCard. */
  signatures?: AgentCardSignature[];
  /** Optional. A URL to an icon for the agent. */
  iconUrl?: string;
}

/**
 * AgentCardSignature represents a JWS signature of an AgentCard.
 * This follows the JSON format of an RFC 7515 JSON Web Signature (JWS).
 */
export interface AgentCardSignature {
  /** REQUIRED. The protected JWS header for the signature. Always a base64url-encoded JSON object. */
  protected: string;
  /** REQUIRED. The computed signature, base64url-encoded. */
  signature: string;
  /** The unprotected JWS header values. */
  header?: Record<string, any>; // google.protobuf.Struct
}

// ============================================================================
// SECURITY TYPES
// ============================================================================

/**
 * Defines authentication details, used for push notifications.
 */
export interface AuthenticationInfo {
  /** REQUIRED. HTTP Authentication Scheme from IANA registry. Examples: "Bearer", "Basic", "Digest". */
  scheme: string;
  /** Push Notification credentials. Format depends on the scheme (e.g., token for Bearer). */
  credentials?: string;
}

/**
 * A list of strings.
 */
export interface StringList {
  /** The individual string values. */
  list: string[];
}

/**
 * Defines the security requirements for an agent.
 */
export interface SecurityRequirement {
  /** A map of security schemes to the required scopes. */
  schemes: Record<string, StringList>;
}

/**
 * Defines a security scheme that can be used to secure an agent's endpoints.
 * This is a discriminated union type based on the OpenAPI 3.2 Security Scheme Object.
 */
export interface SecurityScheme {
  scheme:
    | {
        type: 'api_key';
        value: APIKeySecurityScheme;
      }
    | {
        type: 'http_auth';
        value: HTTPAuthSecurityScheme;
      }
    | {
        type: 'oauth2';
        value: OAuth2SecurityScheme;
      }
    | {
        type: 'openid_connect';
        value: OpenIdConnectSecurityScheme;
      }
    | {
        type: 'mtls';
        value: MutualTlsSecurityScheme;
      };
}

/**
 * Defines a security scheme using an API key.
 */
export interface APIKeySecurityScheme {
  /** An optional description for the security scheme. */
  description?: string;
  /** REQUIRED. The location of the API key. Valid values: "query", "header", or "cookie". */
  location: string;
  /** REQUIRED. The name of the header, query, or cookie parameter to be used. */
  name: string;
}

/**
 * Defines a security scheme using HTTP authentication.
 */
export interface HTTPAuthSecurityScheme {
  /** An optional description for the security scheme. */
  description?: string;
  /** REQUIRED. The name of the HTTP Authentication scheme (e.g., "Bearer"). */
  scheme: string;
  /** A hint to the client to identify how the bearer token is formatted (e.g., "JWT"). */
  bearerFormat?: string;
}

/**
 * Defines a security scheme using OAuth 2.0.
 */
export interface OAuth2SecurityScheme {
  /** An optional description for the security scheme. */
  description?: string;
  /** REQUIRED. An object containing configuration information for the supported OAuth 2.0 flows. */
  flows: OAuthFlows;
  /** URL to the OAuth2 authorization server metadata [RFC 8414]. TLS is required. */
  oauth2MetadataUrl?: string;
}

/**
 * Defines a security scheme using OpenID Connect.
 */
export interface OpenIdConnectSecurityScheme {
  /** An optional description for the security scheme. */
  description?: string;
  /** REQUIRED. The OpenID Connect Discovery URL for the OIDC provider's metadata. */
  openIdConnectUrl: string;
}

/**
 * Defines a security scheme using mTLS authentication.
 */
export interface MutualTlsSecurityScheme {
  /** An optional description for the security scheme. */
  description?: string;
}

/**
 * Defines the configuration for the supported OAuth 2.0 flows.
 */
export interface OAuthFlows {
  flow:
    | {
        type: 'authorization_code';
        value: AuthorizationCodeOAuthFlow;
      }
    | {
        type: 'client_credentials';
        value: ClientCredentialsOAuthFlow;
      }
    | {
        type: 'implicit';
        value: ImplicitOAuthFlow;
      }
    | {
        type: 'password';
        value: PasswordOAuthFlow;
      }
    | {
        type: 'device_code';
        value: DeviceCodeOAuthFlow;
      };
}

/**
 * Defines configuration details for the OAuth 2.0 Authorization Code flow.
 */
export interface AuthorizationCodeOAuthFlow {
  /** REQUIRED. The authorization URL to be used for this flow. */
  authorizationUrl: string;
  /** REQUIRED. The token URL to be used for this flow. */
  tokenUrl: string;
  /** The URL to be used for obtaining refresh tokens. */
  refreshUrl?: string;
  /** REQUIRED. The available scopes for the OAuth2 security scheme. */
  scopes: Record<string, string>;
  /** Indicates if PKCE (RFC 7636) is required for this flow. */
  pkceRequired?: boolean;
}

/**
 * Defines configuration details for the OAuth 2.0 Client Credentials flow.
 */
export interface ClientCredentialsOAuthFlow {
  /** REQUIRED. The token URL to be used for this flow. */
  tokenUrl: string;
  /** The URL to be used for obtaining refresh tokens. */
  refreshUrl?: string;
  /** REQUIRED. The available scopes for the OAuth2 security scheme. */
  scopes: Record<string, string>;
}

/**
 * Deprecated: Use Authorization Code + PKCE instead.
 * @deprecated
 */
export interface ImplicitOAuthFlow {
  /** The authorization URL to be used for this flow. */
  authorizationUrl?: string;
  /** The URL to be used for obtaining refresh tokens. */
  refreshUrl?: string;
  /** The available scopes for the OAuth2 security scheme. */
  scopes?: Record<string, string>;
}

/**
 * Deprecated: Use Authorization Code + PKCE or Device Code.
 * @deprecated
 */
export interface PasswordOAuthFlow {
  /** The token URL to be used for this flow. */
  tokenUrl?: string;
  /** The URL to be used for obtaining refresh tokens. */
  refreshUrl?: string;
  /** The available scopes for the OAuth2 security scheme. */
  scopes?: Record<string, string>;
}

/**
 * Defines configuration details for the OAuth 2.0 Device Code flow (RFC 8628).
 * This flow is designed for input-constrained devices such as IoT devices and CLI tools.
 */
export interface DeviceCodeOAuthFlow {
  /** REQUIRED. The device authorization endpoint URL. */
  deviceAuthorizationUrl: string;
  /** REQUIRED. The token URL to be used for this flow. */
  tokenUrl: string;
  /** The URL to be used for obtaining refresh tokens. */
  refreshUrl?: string;
  /** REQUIRED. The available scopes for the OAuth2 security scheme. */
  scopes: Record<string, string>;
}

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

/**
 * Configuration of a send message request.
 */
export interface SendMessageConfiguration {
  /** A list of media types the client is prepared to accept for response parts. */
  acceptedOutputModes?: string[];
  /** Configuration for the agent to send push notifications for task updates. */
  taskPushNotificationConfig?: TaskPushNotificationConfig;
  /** The maximum number of most recent messages from the task's history to retrieve in the response. */
  historyLength?: number;
  /** If true, the operation returns immediately after creating the task. Otherwise, waits until terminal/interrupted state. */
  returnImmediately?: boolean;
}

/**
 * A container associating a push notification configuration with a specific task.
 */
export interface TaskPushNotificationConfig {
  /** Optional. Tenant ID. */
  tenant?: string;
  /** A unique identifier (e.g. UUID) for this push notification configuration. */
  id?: string;
  /** The ID of the task this configuration is associated with. */
  taskId?: string;
  /** REQUIRED. The URL where the notification should be sent. */
  url: string;
  /** A token unique for this task or session. */
  token?: string;
  /** Authentication information required to send the notification. */
  authentication?: AuthenticationInfo;
}

// ============================================================================
// RPC REQUEST & RESPONSE TYPES
// ============================================================================

/**
 * Represents a request for the `SendMessage` method.
 */
export interface SendMessageRequest {
  /** Optional. Tenant ID, provided as a path parameter. */
  tenant?: string;
  /** REQUIRED. The message to send to the agent. */
  message: Message;
  /** Configuration for the send request. */
  configuration?: SendMessageConfiguration;
  /** A flexible key-value map for passing additional context or parameters. */
  metadata?: Record<string, any>; // google.protobuf.Struct
}

/**
 * Represents the response for the `SendMessage` method.
 */
export interface SendMessageResponse {
  payload:
    | {
        type: 'task';
        value: Task;
      }
    | {
        type: 'message';
        value: Message;
      };
}

/**
 * A wrapper object used in streaming operations to encapsulate different types of response data.
 */
export interface StreamResponse {
  payload:
    | {
        type: 'task';
        value: Task;
      }
    | {
        type: 'message';
        value: Message;
      }
    | {
        type: 'status_update';
        value: TaskStatusUpdateEvent;
      }
    | {
        type: 'artifact_update';
        value: TaskArtifactUpdateEvent;
      };
}

/**
 * Represents a request for the `GetTask` method.
 */
export interface GetTaskRequest {
  /** Optional. Tenant ID, provided as a path parameter. */
  tenant?: string;
  /** REQUIRED. The resource ID of the task to retrieve. */
  id: string;
  /** The maximum number of most recent messages from the task's history to retrieve. */
  historyLength?: number;
}

/**
 * Parameters for listing tasks with optional filtering criteria.
 */
export interface ListTasksRequest {
  /** Tenant ID, provided as a path parameter. */
  tenant?: string;
  /** Filter tasks by context ID to get tasks from a specific conversation or session. */
  contextId?: string;
  /** Filter tasks by their current status state. */
  status?: TaskState;
  /** The maximum number of tasks to return (1-100, default 50). */
  pageSize?: number;
  /** A page token, received from a previous `ListTasks` call. */
  pageToken?: string;
  /** The maximum number of messages to include in each task's history. */
  historyLength?: number;
  /** Filter tasks which have a status updated after the provided ISO 8601 timestamp. */
  statusTimestampAfter?: Date; // google.protobuf.Timestamp
  /** Whether to include artifacts in the returned tasks. Defaults to false. */
  includeArtifacts?: boolean;
}

/**
 * Result object for `ListTasks` method containing an array of tasks and pagination information.
 */
export interface ListTasksResponse {
  /** REQUIRED. Array of tasks matching the specified criteria. */
  tasks: Task[];
  /** REQUIRED. A token to retrieve the next page of results, or empty if there are no more results. */
  nextPageToken: string;
  /** REQUIRED. The page size used for this response. */
  pageSize: number;
  /** REQUIRED. Total number of tasks available (before pagination). */
  totalSize: number;
}

/**
 * Represents a request for the `CancelTask` method.
 */
export interface CancelTaskRequest {
  /** Optional. Tenant ID, provided as a path parameter. */
  tenant?: string;
  /** REQUIRED. The resource ID of the task to cancel. */
  id: string;
  /** A flexible key-value map for passing additional context or parameters. */
  metadata?: Record<string, any>; // google.protobuf.Struct
}

/**
 * Represents a request for the `SubscribeToTask` method.
 */
export interface SubscribeToTaskRequest {
  /** Optional. Tenant ID, provided as a path parameter. */
  tenant?: string;
  /** REQUIRED. The resource ID of the task to subscribe to. */
  id: string;
}

/**
 * Represents a request for the `GetTaskPushNotificationConfig` method.
 */
export interface GetTaskPushNotificationConfigRequest {
  /** Optional. Tenant ID, provided as a path parameter. */
  tenant?: string;
  /** REQUIRED. The parent task resource ID. */
  taskId: string;
  /** REQUIRED. The resource ID of the configuration to retrieve. */
  id: string;
}

/**
 * Represents a request for the `DeleteTaskPushNotificationConfig` method.
 */
export interface DeleteTaskPushNotificationConfigRequest {
  /** Optional. Tenant ID, provided as a path parameter. */
  tenant?: string;
  /** REQUIRED. The parent task resource ID. */
  taskId: string;
  /** REQUIRED. The resource ID of the configuration to delete. */
  id: string;
}

/**
 * Represents a request for the `ListTaskPushNotificationConfigs` method.
 */
export interface ListTaskPushNotificationConfigsRequest {
  /** Optional. Tenant ID, provided as a path parameter. */
  tenant?: string;
  /** REQUIRED. The parent task resource ID. */
  taskId: string;
  /** The maximum number of configurations to return. */
  pageSize?: number;
  /** A page token received from a previous `ListTaskPushNotificationConfigs` call. */
  pageToken?: string;
}

/**
 * Represents a successful response for the `ListTaskPushNotificationConfigs` method.
 */
export interface ListTaskPushNotificationConfigsResponse {
  /** The list of push notification configurations. */
  configs: TaskPushNotificationConfig[];
  /** A token to retrieve the next page of results, or empty if there are no more results. */
  nextPageToken?: string;
}

/**
 * Represents a request for the `GetExtendedAgentCard` method.
 */
export interface GetExtendedAgentCardRequest {
  /** Optional. Tenant ID, provided as a path parameter. */
  tenant?: string;
}

// ============================================================================
// RPC SERVICE DEFINITION
// ============================================================================

/**
 * A2AService provides operations for interacting with agents using the A2A protocol.
 *
 * HTTP/JSON Endpoints:
 * - POST   /message:send                                      → SendMessage
 * - POST   /message:stream                                    → SendStreamingMessage
 * - GET    /tasks/{id}                                        → GetTask
 * - GET    /tasks                                             → ListTasks
 * - POST   /tasks/{id}:cancel                                 → CancelTask
 * - GET    /tasks/{id}:subscribe                              → SubscribeToTask
 * - POST   /tasks/{task_id}/pushNotificationConfigs           → CreateTaskPushNotificationConfig
 * - GET    /tasks/{task_id}/pushNotificationConfigs/{id}      → GetTaskPushNotificationConfig
 * - GET    /tasks/{task_id}/pushNotificationConfigs           → ListTaskPushNotificationConfigs
 * - GET    /extendedAgentCard                                 → GetExtendedAgentCard
 * - DELETE /tasks/{task_id}/pushNotificationConfigs/{id}      → DeleteTaskPushNotificationConfig
 *
 * All endpoints support optional tenant path parameter: /{tenant}/...
 *
 * JSON-RPC Method Names (via /message:send and /message:stream):
 * - SendMessage
 * - SendStreamingMessage (returns server-sent events)
 *
 * Protocol Bindings Supported:
 * - HTTP+JSON (REST)
 * - gRPC (using protobuf)
 * - JSON-RPC 2.0
 */
export interface A2AService {
  /**
   * SendMessage: Sends a message to an agent.
   * @request SendMessageRequest
   * @response SendMessageResponse
   * @http POST /message:send
   * @jsonrpc SendMessage
   */
  sendMessage(request: SendMessageRequest): Promise<SendMessageResponse>;

  /**
   * SendStreamingMessage: Sends a streaming message to an agent.
   * Allows for real-time interaction and status updates.
   * @request SendMessageRequest
   * @response AsyncIterable<StreamResponse>
   * @http POST /message:stream
   * @jsonrpc SendStreamingMessage
   */
  sendStreamingMessage(
    request: SendMessageRequest
  ): AsyncIterable<StreamResponse>;

  /**
   * GetTask: Gets the latest state of a task.
   * @request GetTaskRequest (field: id is required)
   * @response Task
   * @http GET /tasks/{id}
   * @jsonrpc GetTask
   */
  getTask(request: GetTaskRequest): Promise<Task>;

  /**
   * ListTasks: Lists tasks that match the specified filter.
   * @request ListTasksRequest
   * @response ListTasksResponse
   * @http GET /tasks
   * @jsonrpc ListTasks
   */
  listTasks(request: ListTasksRequest): Promise<ListTasksResponse>;

  /**
   * CancelTask: Cancels a task in progress.
   * @request CancelTaskRequest (field: id is required)
   * @response Task
   * @http POST /tasks/{id}:cancel
   * @jsonrpc CancelTask
   */
  cancelTask(request: CancelTaskRequest): Promise<Task>;

  /**
   * SubscribeToTask: Subscribes to task updates for tasks not in a terminal state.
   * Returns `UnsupportedOperationError` if the task is already in a terminal state.
   * @request SubscribeToTaskRequest (field: id is required)
   * @response AsyncIterable<StreamResponse>
   * @http GET /tasks/{id}:subscribe
   * @jsonrpc SubscribeToTask
   */
  subscribeToTask(request: SubscribeToTaskRequest): AsyncIterable<StreamResponse>;

  /**
   * CreateTaskPushNotificationConfig: Creates a push notification config for a task.
   * @request TaskPushNotificationConfig
   * @response TaskPushNotificationConfig
   * @http POST /tasks/{task_id}/pushNotificationConfigs
   * @jsonrpc CreateTaskPushNotificationConfig
   */
  createTaskPushNotificationConfig(
    request: TaskPushNotificationConfig
  ): Promise<TaskPushNotificationConfig>;

  /**
   * GetTaskPushNotificationConfig: Gets a push notification config for a task.
   * @request GetTaskPushNotificationConfigRequest
   * @response TaskPushNotificationConfig
   * @http GET /tasks/{task_id}/pushNotificationConfigs/{id}
   * @jsonrpc GetTaskPushNotificationConfig
   */
  getTaskPushNotificationConfig(
    request: GetTaskPushNotificationConfigRequest
  ): Promise<TaskPushNotificationConfig>;

  /**
   * ListTaskPushNotificationConfigs: Get a list of push notifications configured for a task.
   * @request ListTaskPushNotificationConfigsRequest
   * @response ListTaskPushNotificationConfigsResponse
   * @http GET /tasks/{task_id}/pushNotificationConfigs
   * @jsonrpc ListTaskPushNotificationConfigs
   */
  listTaskPushNotificationConfigs(
    request: ListTaskPushNotificationConfigsRequest
  ): Promise<ListTaskPushNotificationConfigsResponse>;

  /**
   * GetExtendedAgentCard: Gets the extended agent card for the authenticated agent.
   * @request GetExtendedAgentCardRequest
   * @response AgentCard
   * @http GET /extendedAgentCard
   * @jsonrpc GetExtendedAgentCard
   */
  getExtendedAgentCard(
    request: GetExtendedAgentCardRequest
  ): Promise<AgentCard>;

  /**
   * DeleteTaskPushNotificationConfig: Deletes a push notification config for a task.
   * @request DeleteTaskPushNotificationConfigRequest
   * @response void
   * @http DELETE /tasks/{task_id}/pushNotificationConfigs/{id}
   * @jsonrpc DeleteTaskPushNotificationConfig
   */
  deleteTaskPushNotificationConfig(
    request: DeleteTaskPushNotificationConfigRequest
  ): Promise<void>;
}
```

---

## Summary of Key Information

### **Enums (2 total)**
1. **TaskState** - 9 values (UNSPECIFIED to AUTH_REQUIRED) with terminal vs. interrupted states
2. **Role** - 3 values (UNSPECIFIED, USER, AGENT)

### **Message Types (38 total)**
- **Core**: Task, Message, Part, Artifact, TaskStatus
- **Events**: TaskStatusUpdateEvent, TaskArtifactUpdateEvent
- **Agent Card**: AgentCard, AgentInterface, AgentProvider, AgentCapabilities, AgentExtension, AgentSkill, AgentCardSignature
- **Security** (11): SecurityScheme, APIKeySecurityScheme, HTTPAuthSecurityScheme, OAuth2SecurityScheme, OpenIdConnectSecurityScheme, MutualTlsSecurityScheme, OAuthFlows, AuthorizationCodeOAuthFlow, ClientCredentialsOAuthFlow, ImplicitOAuthFlow (deprecated), PasswordOAuthFlow (deprecated), DeviceCodeOAuthFlow
- **Config**: SendMessageConfiguration, TaskPushNotificationConfig, AuthenticationInfo, StringList, SecurityRequirement
- **RPC**: SendMessageRequest/Response, GetTaskRequest, ListTasksRequest/Response, CancelTaskRequest, SubscribeToTaskRequest, GetTaskPushNotificationConfigRequest, DeleteTaskPushNotificationConfigRequest, ListTaskPushNotificationConfigsRequest/Response, GetExtendedAgentCardRequest, StreamResponse

### **RPC Methods (11 total)**
All support HTTP+JSON, gRPC, and JSON-RPC bindings with tenant path parameter support.

### **Protocol Bindings**
- HTTP+JSON (REST with `/message:send`, `/message:stream`, `/tasks/*` endpoints)
- gRPC (protobuf over HTTP/2)
- JSON-RPC 2.0 (via stream endpoints)

This is the complete, authoritative specification ready for implementation.