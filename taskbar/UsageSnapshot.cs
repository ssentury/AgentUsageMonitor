using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Web.Script.Serialization;

namespace AgentUsageTaskbar
{
    internal sealed class LimitInfo
    {
        public string Window;
        public double UsedPercent;
        public DateTime? ResetsAt;
        public bool Stale;
    }

    internal sealed class ProviderInfo
    {
        public string Id;
        public string Label;
        public bool HasUsage;
        public bool Active;
        public double UsdPer30s;
        public double TodayUsd;
        public bool Unpriced;
        public string LimitStatus;
        public List<LimitInfo> Limits = new List<LimitInfo>();
    }

    // Mirrors GET /api/taskbar. Unknown or missing fields fall back to neutral values
    // so a newer service never crashes an older indicator.
    internal sealed class UsageSnapshot
    {
        public List<ProviderInfo> Providers = new List<ProviderInfo>();

        public static UsageSnapshot Parse(string json)
        {
            var root = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
            var snapshot = new UsageSnapshot();
            if (root == null) return snapshot;
            foreach (var item in List(root, "providers"))
            {
                if (!(item is Dictionary<string, object> provider)) continue;
                var info = new ProviderInfo
                {
                    Id = Text(provider, "id"),
                    Label = Text(provider, "label") ?? Text(provider, "id"),
                    HasUsage = Flag(provider, "hasUsage"),
                    Active = Flag(provider, "active"),
                    UsdPer30s = Number(provider, "usdPer30s"),
                    TodayUsd = Number(provider, "todayUsd"),
                    Unpriced = Flag(provider, "unpriced"),
                    LimitStatus = Text(provider, "limitStatus") ?? "unknown",
                };
                foreach (var entry in List(provider, "limits"))
                {
                    if (!(entry is Dictionary<string, object> limit)) continue;
                    info.Limits.Add(new LimitInfo
                    {
                        Window = Text(limit, "window") ?? "?",
                        UsedPercent = Number(limit, "usedPercent"),
                        ResetsAt = Date(limit, "resetsAt"),
                        Stale = Flag(limit, "stale"),
                    });
                }
                snapshot.Providers.Add(info);
            }
            return snapshot;
        }

        private static IEnumerable List(Dictionary<string, object> values, string key)
        {
            return values.TryGetValue(key, out var value) && value is IEnumerable list && !(value is string)
                ? list
                : new object[0];
        }

        private static string Text(Dictionary<string, object> values, string key)
        {
            return values.TryGetValue(key, out var value) ? value as string : null;
        }

        private static bool Flag(Dictionary<string, object> values, string key)
        {
            return values.TryGetValue(key, out var value) && value is bool flag && flag;
        }

        private static double Number(Dictionary<string, object> values, string key)
        {
            if (!values.TryGetValue(key, out var value) || value == null) return 0;
            try { return Convert.ToDouble(value, CultureInfo.InvariantCulture); }
            catch (FormatException) { return 0; }
            catch (InvalidCastException) { return 0; }
        }

        private static DateTime? Date(Dictionary<string, object> values, string key)
        {
            var text = Text(values, key);
            return text != null && DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var date)
                ? date.ToLocalTime()
                : (DateTime?)null;
        }
    }
}
