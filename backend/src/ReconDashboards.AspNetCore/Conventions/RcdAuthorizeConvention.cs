using Microsoft.AspNetCore.Mvc.ApplicationModels;
using Microsoft.AspNetCore.Mvc.Authorization;
using ReconDashboards.Core.Options;

namespace ReconDashboards.AspNetCore.Conventions;

/// <summary>
/// Attaches host-configured authorization policies to library endpoints based
/// on their <see cref="RcdPolicySlotAttribute"/> (action attribute wins over
/// controller). A null slot adds no metadata — the host's fallback policy
/// (typically RequireAuthenticatedUser) still applies, so endpoints are never
/// accidentally anonymous.
/// </summary>
public sealed class RcdAuthorizeConvention(ReconDashboardsOptions options) : IApplicationModelConvention
{
    public void Apply(ApplicationModel application)
    {
        foreach (var controller in application.Controllers
                     .Where(c => c.ControllerType.Assembly == typeof(RcdAuthorizeConvention).Assembly))
        {
            var controllerSlot = controller.Attributes.OfType<RcdPolicySlotAttribute>().FirstOrDefault()?.Slot;

            foreach (var action in controller.Actions)
            {
                var slot = action.Attributes.OfType<RcdPolicySlotAttribute>().FirstOrDefault()?.Slot
                    ?? controllerSlot;

                var policy = slot switch
                {
                    RcdPolicySlot.View => options.ViewPolicy,
                    RcdPolicySlot.Author => options.AuthorPolicy,
                    RcdPolicySlot.Admin => options.AdminPolicy,
                    _ => null,
                };

                if (policy is not null)
                {
                    action.Filters.Add(new AuthorizeFilter(policy));
                }
            }
        }
    }
}
