using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ApplicationModels;

namespace ReconDashboards.AspNetCore.Conventions;

/// <summary>
/// Prepends the host-configured prefix + version segment to every controller in
/// THIS assembly (host controllers are untouched). Final shape:
/// {RoutePrefix}/v1/{controller route}.
/// </summary>
public sealed class RcdRoutePrefixConvention(string routePrefix) : IApplicationModelConvention
{
    private readonly AttributeRouteModel _prefix = new(new RouteAttribute($"{routePrefix.Trim('/')}/v1"));

    public void Apply(ApplicationModel application)
    {
        foreach (var controller in application.Controllers
                     .Where(c => c.ControllerType.Assembly == typeof(RcdRoutePrefixConvention).Assembly))
        {
            foreach (var selector in controller.Selectors)
            {
                selector.AttributeRouteModel = selector.AttributeRouteModel is null
                    ? _prefix
                    : AttributeRouteModel.CombineAttributeRouteModel(_prefix, selector.AttributeRouteModel);
            }
        }
    }
}
