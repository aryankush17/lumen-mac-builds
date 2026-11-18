// Fixed, reviewed Pexels assets. These are illustrative stock scenes, not client work.
// Media stays on the provider CDN; exports retain source links and require internet.
export const stockPhotos = {
  exterior: [7598374, 'A contemporary wooden house with glass windows in a forest'],
  ceramic: [8356250, 'A ceramic vase and natural textures on a beige background'],
  garden: [13349472, 'A pathway through a lush botanical garden'],
  flowers: [4395272, 'Flowers and climbing plants in a courtyard garden'],
  croissant: [18058319, 'Fresh croissants on display in a bakery'],
  room: [1643383, 'Contemporary open-plan living room with a sofa and kitchen'],
  interior: [1571460, 'Warm living room with layered furniture and natural light'],
  home: [1571458, 'Contemporary interior with carefully arranged furniture'],
  workshop: [3184291, 'A group collaborating around a table'],
  team: [3184465, 'Two people shaking hands in a workspace'],
  planning: [3184339, 'A team discussing ideas around a desk'],
  food: [1640777, 'Colourful vegetables and freshly prepared food'],
  dining: [262978, 'Plates of freshly prepared food being served'],
  restaurant: [260922, 'Tables and seating in a restaurant'],
  coffee: [302899, 'Milk being poured into coffee'],
  bread: [2074130, 'Breakfast dishes and coffee spread across a table'],
  training: [1552242, 'People training with battle ropes in a fitness studio'],
  gym: [841130, 'A person lifting weights in a gym'],
  spa: [3757942, 'A person relaxing during a spa treatment'],
  hair: [4506108, 'A close-up of a person with long hair'],
  warehouse: [1267338, 'A forklift working in a warehouse'],
  sustainability: [1108572, 'A small plant growing inside a glass bulb'],
  bridge: [1761279, 'A suspension footbridge through a green forest'],
  meeting: [1595385, 'A meeting space arranged for a gathering'],
  audience: [2608517, 'Audience attending a presentation'],
  portrait: [167964, 'A black-and-white silhouette reaching toward the camera'],
  valley: [3225517, 'A mountain valley with a winding path'],
  lake: [417074, 'Mountains reflected in a lake'],
  desk: [356056, 'Computer equipment on a work desk'],
  code: [574071, 'A laptop used for software development'],
} as const
export type Photo = keyof typeof stockPhotos
export function photoUrl(key: Photo, width = 1400) {
  return `https://images.pexels.com/photos/${stockPhotos[key][0]}/pexels-photo-${stockPhotos[key][0]}.jpeg?auto=compress&cs=tinysrgb&w=${width}`
}
export const stockFilms = {
  coast: {src:'https://videos.pexels.com/video-files/4631568/4631568-hd_1920_1080_24fps.mp4',source:'https://www.pexels.com/video/aerial-view-of-ocean-waves-4631568/',credit:'ArtHouse Studio',title:'A quiet moment by the coast',poster:'https://images.pexels.com/videos/4631568/pexels-photo-4631568.jpeg?auto=compress&cs=tinysrgb&w=1400'},
  coffee: {src:'https://videos.pexels.com/video-files/9717005/9717005-hd_1080_1920_25fps.mp4',source:'https://www.pexels.com/video/a-person-pouring-hot-coffee-in-a-cup-9717005/',credit:'Taryn Elliott',title:'The ritual of a morning coffee',poster:'https://images.pexels.com/videos/9717005/adventure-at-the-beach-baking-beach-9717005.jpeg?auto=compress&cs=tinysrgb&w=1000'},
}
export const mediaCredits = `Lumen template stock media\n\nPhotos and videos are illustrative stock scenes, not the website owner's premises, staff, portfolio, or endorsements. Replace them with accurate brand media where needed.\n\nPexels license: https://www.pexels.com/license/\nTerms: https://www.pexels.com/terms-of-service/\nMedia is linked from Pexels CDN, not bundled in this export. Internet access and continued provider availability are required. For independent hosting, obtain and host licensed copies and update the URLs.\n\n${Object.values(stockPhotos).map(([id,alt])=>`${alt}: https://www.pexels.com/photo/${id}/`).join('\n')}\n\n${Object.values(stockFilms).map(v=>`${v.title} — ${v.credit}: ${v.source}`).join('\n')}\n\nDo not redistribute media as standalone stock or imply endorsement. Review rights for identifiable people, brands and property for your particular use.\n`
