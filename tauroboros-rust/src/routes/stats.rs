use crate::db::queries::*;
use crate::error::ApiResult;
use crate::models::{DailyUsage, HourlyUsage};
use crate::state::AppStateType;
use rocket::routes;
use rocket::serde::json::{json, Json, Value};
use rocket::State;
use rocket::{get, Route};

#[get("/api/stats/usage?<range>")]
async fn get_usage_stats(
    state: &State<AppStateType>,
    range: Option<String>,
) -> ApiResult<Json<Value>> {
    let range = range.unwrap_or_else(|| "30d".to_string());

    // Get messages within range
    let cutoff = match range.as_str() {
        "24h" => chrono::Utc::now().timestamp() - 86400,
        "7d" => chrono::Utc::now().timestamp() - 604800,
        "30d" => chrono::Utc::now().timestamp() - 2592000,
        _ => 0,
    };

    let stats: (Option<i64>, Option<f64>) = sqlx::query_as(
        r#"
        SELECT 
            SUM(total_tokens) as total_tokens,
            SUM(cost_total) as total_cost
        FROM session_messages
        WHERE timestamp >= ?
        "#,
    )
    .bind(cutoff)
    .fetch_one(&state.db)
    .await
    .map_err(crate::error::ApiError::Database)?;

    // Generate hourly data for 24h view
    let hourly_data: Vec<Value> = if range == "24h" {
        sqlx::query_as::<_, (String, Option<i64>, Option<f64>)>(
            r#"
            SELECT 
                strftime('%Y-%m-%dT%H:00:00', datetime(timestamp, 'unixepoch')) as hour,
                SUM(total_tokens) as tokens,
                SUM(cost_total) as cost
            FROM session_messages
            WHERE timestamp >= ?
            GROUP BY hour
            ORDER BY hour
            "#,
        )
        .bind(cutoff)
        .fetch_all(&state.db)
        .await
        .map_err(crate::error::ApiError::Database)?
        .into_iter()
        .map(|(hour, tokens, cost)| {
            json!({
                "hour": hour,
                "tokens": tokens.unwrap_or(0),
                "cost": cost.unwrap_or(0.0),
            })
        })
        .collect()
    } else {
        vec![]
    };

    // Generate daily data for longer views
    let daily_data: Vec<Value> = if range != "24h" {
        sqlx::query_as::<_, (String, Option<i64>, Option<f64>)>(
            r#"
            SELECT 
                strftime('%Y-%m-%d', datetime(timestamp, 'unixepoch')) as date,
                SUM(total_tokens) as tokens,
                SUM(cost_total) as cost
            FROM session_messages
            WHERE timestamp >= ?
            GROUP BY date
            ORDER BY date
            "#,
        )
        .bind(cutoff)
        .fetch_all(&state.db)
        .await
        .map_err(crate::error::ApiError::Database)?
        .into_iter()
        .map(|(date, tokens, cost)| {
            json!({
                "date": date,
                "tokens": tokens.unwrap_or(0),
                "cost": cost.unwrap_or(0.0),
            })
        })
        .collect()
    } else {
        vec![]
    };

    Ok(Json(json!({
        "range": range,
        "totalTokens": stats.0.unwrap_or(0),
        "totalCost": stats.1.unwrap_or(0.0),
        "hourlyData": hourly_data,
        "dailyData": daily_data,
    })))
}

#[get("/api/stats/tasks")]
async fn get_task_stats(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    let tasks = get_tasks(&state.db).await?;

    let total = tasks.len() as i32;

    let mut by_status = serde_json::Map::new();
    for task in &tasks {
        let status_str = format!("{:?}", task.status).to_lowercase();
        let count = by_status
            .get(&status_str)
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            + 1;
        by_status.insert(status_str, json!(count));
    }

    let done_count = by_status.get("done").and_then(|v| v.as_i64()).unwrap_or(0);
    let completion_rate = if total > 0 {
        (done_count as f64 / total as f64) * 100.0
    } else {
        0.0
    };

    Ok(Json(json!({
        "total": total,
        "byStatus": by_status,
        "completionRate": completion_rate,
        "averageExecutionTime": 0, // Would need completed task timing
    })))
}

#[get("/api/stats/models")]
async fn get_model_stats(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    let stats: Vec<(String, i64, Option<i64>, Option<f64>)> = sqlx::query_as(
        r#"
        SELECT 
            COALESCE(model_id, 'unknown') as model,
            COUNT(*) as count,
            SUM(total_tokens) as tokens,
            SUM(cost_total) as cost
        FROM session_messages
        WHERE model_id IS NOT NULL
        GROUP BY model_id
        ORDER BY count DESC
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(crate::error::ApiError::Database)?;

    let models: Vec<Value> = stats
        .into_iter()
        .map(|(model, count, tokens, cost)| {
            json!({
                "model": model,
                "count": count,
                "tokens": tokens.unwrap_or(0),
                "cost": cost.unwrap_or(0.0),
            })
        })
        .collect();

    Ok(Json(json!({
        "models": models,
    })))
}

#[get("/api/stats/duration")]
async fn get_duration_stats(state: &State<AppStateType>) -> ApiResult<Json<i64>> {
    let completed_task_runs: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM task_runs
        WHERE completed_at IS NOT NULL
          AND created_at IS NOT NULL
          AND status IN ('done', 'failed')
        "#,
    )
    .fetch_one(&state.db)
    .await
    .map_err(crate::error::ApiError::Database)?;

    let avg_duration_seconds: Option<f64> = if completed_task_runs > 0 {
        sqlx::query_scalar(
            r#"
                        SELECT COALESCE(AVG((completed_at - created_at) * 1.0), 0.0)
            FROM task_runs
            WHERE completed_at IS NOT NULL
              AND created_at IS NOT NULL
              AND status IN ('done', 'failed')
            "#,
        )
        .fetch_one(&state.db)
        .await
        .map_err(crate::error::ApiError::Database)?
    } else {
        sqlx::query_scalar(
            r#"
                        SELECT COALESCE(AVG((completed_at - created_at) * 1.0), 0.0)
            FROM tasks
            WHERE completed_at IS NOT NULL
              AND created_at IS NOT NULL
              AND status = 'done'
            "#,
        )
        .fetch_one(&state.db)
        .await
        .map_err(crate::error::ApiError::Database)?
    };

    let minutes = (avg_duration_seconds.unwrap_or(0.0) / 60.0).round() as i64;
    Ok(Json(minutes))
}

#[get("/api/stats/timeseries/hourly")]
async fn get_hourly_timeseries(state: &State<AppStateType>) -> ApiResult<Json<Vec<HourlyUsage>>> {
    let cutoff = chrono::Utc::now().timestamp() - 86400; // Last 24 hours

    let hourly_data: Vec<HourlyUsage> = sqlx::query_as::<_, (String, Option<i64>, Option<f64>)>(
        r#"
        SELECT 
            strftime('%Y-%m-%dT%H:00:00', datetime(timestamp, 'unixepoch')) as hour,
            SUM(total_tokens) as tokens,
            SUM(cost_total) as cost
        FROM session_messages
        WHERE timestamp >= ?
        GROUP BY hour
        ORDER BY hour
        "#,
    )
    .bind(cutoff)
    .fetch_all(&state.db)
    .await
    .map_err(crate::error::ApiError::Database)?
    .into_iter()
    .map(|(hour, tokens, cost)| {
        HourlyUsage {
            hour,
            requests: 0, // Would need to count requests
            tokens: tokens.unwrap_or(0),
            cost: cost.unwrap_or(0.0),
        }
    })
    .collect();

    Ok(Json(hourly_data))
}

#[get("/api/stats/timeseries/daily?<days>")]
async fn get_daily_timeseries(
    state: &State<AppStateType>,
    days: Option<i64>,
) -> ApiResult<Json<Vec<DailyUsage>>> {
    let days = days.unwrap_or(30);
    let cutoff = chrono::Utc::now().timestamp() - (days * 86400);

    let daily_data: Vec<DailyUsage> = sqlx::query_as::<_, (String, Option<i64>, Option<f64>)>(
        r#"
        SELECT 
            strftime('%Y-%m-%d', datetime(timestamp, 'unixepoch')) as date,
            SUM(total_tokens) as tokens,
            SUM(cost_total) as cost
        FROM session_messages
        WHERE timestamp >= ?
        GROUP BY date
        ORDER BY date
        "#,
    )
    .bind(cutoff)
    .fetch_all(&state.db)
    .await
    .map_err(crate::error::ApiError::Database)?
    .into_iter()
    .map(|(date, tokens, cost)| {
        DailyUsage {
            date,
            requests: 0, // Would need to count requests
            tokens: tokens.unwrap_or(0),
            cost: cost.unwrap_or(0.0),
        }
    })
    .collect();

    Ok(Json(daily_data))
}

pub fn routes() -> Vec<Route> {
    routes![
        get_usage_stats,
        get_task_stats,
        get_model_stats,
        get_duration_stats,
        get_hourly_timeseries,
        get_daily_timeseries,
    ]
}
