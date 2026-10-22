//! Token-bucket rate limiting.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct Bucket {
    tokens: f64,
    last: Instant,
    rate: f64,
    burst: f64,
}

impl Bucket {
    pub fn new(rate_per_sec: f64, burst: f64) -> Self {
        Self { tokens: burst, last: Instant::now(), rate: rate_per_sec, burst }
    }

    fn refill(&mut self, now: Instant) {
        let dt = now.saturating_duration_since(self.last).as_secs_f64();
        self.tokens = (self.tokens + dt * self.rate).min(self.burst);
        self.last = now;
    }

    pub fn try_take(&mut self) -> bool {
        self.try_take_at(Instant::now())
    }

    pub fn try_take_at(&mut self, now: Instant) -> bool {
        self.refill(now);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    fn is_full_at(&mut self, now: Instant) -> bool {
        self.refill(now);
        self.tokens >= self.burst
    }
}

/// Per-IP limiter for login and registration attempts.
pub struct IpLimiter {
    buckets: Mutex<HashMap<IpAddr, Bucket>>,
    rate: f64,
    burst: f64,
}

impl IpLimiter {
    pub fn new(per_min: f64, burst: f64) -> Self {
        Self { buckets: Mutex::new(HashMap::new()), rate: per_min / 60.0, burst }
    }

    pub fn check(&self, ip: IpAddr) -> bool {
        let mut map = self.buckets.lock().unwrap_or_else(|p| p.into_inner());
        if map.len() > 10_000 {
            // Drop buckets that are full again; they carry no information.
            let now = Instant::now();
            map.retain(|_, b| !b.is_full_at(now));
        }
        map.entry(ip).or_insert_with(|| Bucket::new(self.rate, self.burst)).try_take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn bucket_limits_and_refills() {
        let t0 = Instant::now();
        let mut b = Bucket::new(2.0, 3.0);
        b.last = t0;
        assert!(b.try_take_at(t0));
        assert!(b.try_take_at(t0));
        assert!(b.try_take_at(t0));
        assert!(!b.try_take_at(t0), "burst exhausted");
        assert!(b.try_take_at(t0 + Duration::from_millis(600)), "refilled 1.2 tokens");
        assert!(!b.try_take_at(t0 + Duration::from_millis(600)));
    }

    #[test]
    fn ip_limiter_is_per_ip() {
        let l = IpLimiter::new(60.0, 2.0);
        let a: IpAddr = "10.0.0.1".parse().unwrap();
        let b: IpAddr = "10.0.0.2".parse().unwrap();
        assert!(l.check(a));
        assert!(l.check(a));
        assert!(!l.check(a));
        assert!(l.check(b));
    }
}
