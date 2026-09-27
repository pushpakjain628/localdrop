//! A single error type that maps directly onto the protocol's error envelope.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::protocol::{ApiErrorCode, ApiErrorDetail, ApiErrorEnvelope};

/// Application error. Every failure path in the server produces one of these, and
/// [`IntoResponse`] guarantees the HTTP status and the `code` in the body always agree.
#[derive(Debug)]
pub struct ApiError {
    pub code: ApiErrorCode,
    pub message: String,
    pub details: Option<serde_json::Map<String, serde_json::Value>>,
}

impl ApiError {
    pub fn new(code: ApiErrorCode, message: impl Into<String>) -> Self {
        ApiError {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_detail(mut self, key: &str, value: impl Into<serde_json::Value>) -> Self {
        self.details
            .get_or_insert_with(Default::default)
            .insert(key.to_string(), value.into());
        self
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        ApiError::new(ApiErrorCode::Unauthorized, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        ApiError::new(ApiErrorCode::NotFound, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        ApiError::new(ApiErrorCode::Forbidden, message)
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        ApiError::new(ApiErrorCode::InvalidRequest, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        ApiError::new(ApiErrorCode::InternalError, message)
    }

    pub fn transfer_not_found(message: impl Into<String>) -> Self {
        ApiError::new(ApiErrorCode::TransferNotFound, message)
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.code.http_status())
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        // Log server-side faults at error level; a rejected upload is routine, not an incident.
        if self.code == ApiErrorCode::InternalError {
            tracing::error!(error = %self.message, "request failed");
        } else {
            tracing::debug!(code = ?self.code, error = %self.message, "request rejected");
        }
        let body = ApiErrorEnvelope {
            error: ApiErrorDetail {
                code: self.code,
                message: self.message,
                details: self.details,
            },
        };
        (status, Json(body)).into_response()
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(err: rusqlite::Error) -> Self {
        ApiError::internal(format!("database error: {err}"))
    }
}

impl From<std::io::Error> for ApiError {
    fn from(err: std::io::Error) -> Self {
        ApiError::internal(format!("file system error: {err}"))
    }
}

/// The storage/database/config layers all report failures as a `String`. Funnelling those
/// through one conversion keeps `?` usable in the handlers instead of `.map_err` on every
/// call, and guarantees they surface as a 500 rather than accidentally as a 200.
impl From<String> for ApiError {
    fn from(message: String) -> Self {
        ApiError::internal(message)
    }
}

impl From<&str> for ApiError {
    fn from(message: &str) -> Self {
        ApiError::internal(message.to_string())
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_code_maps_to_the_documented_status() {
        let cases = [
            (ApiErrorCode::Unauthorized, 401),
            (ApiErrorCode::Forbidden, 403),
            (ApiErrorCode::NotFound, 404),
            (ApiErrorCode::InvalidRequest, 400),
            (ApiErrorCode::ProtocolMismatch, 400),
            (ApiErrorCode::PairingFailed, 403),
            (ApiErrorCode::TransferNotFound, 404),
            (ApiErrorCode::TransferConflict, 409),
            (ApiErrorCode::ChecksumMismatch, 422),
            (ApiErrorCode::SizeMismatch, 422),
            (ApiErrorCode::StorageUnwritable, 507),
            (ApiErrorCode::InsufficientSpace, 507),
            (ApiErrorCode::InternalError, 500),
        ];
        for (code, expected) in cases {
            assert_eq!(code.http_status(), expected, "{code:?}");
        }
    }

    #[tokio::test]
    async fn renders_the_protocol_error_envelope() {
        let error = ApiError::invalid("bad filename").with_detail("filename", "..");
        let response = error.into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"]["code"], "invalid_request");
        assert_eq!(json["error"]["message"], "bad filename");
        assert_eq!(json["error"]["details"]["filename"], "..");
    }

    #[tokio::test]
    async fn omits_details_when_absent() {
        let response = ApiError::unauthorized("nope").into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(json["error"].get("details").is_none());
    }
}
